/**
 * Salute del calendario: GET /api/health/calendar (fase F2 del passaggio a
 * Radicale; design §16.5 "Monitoraggio", §6.5, §7, §13.1; contratto dei
 * moduli docs/calendar-radicale/contracts/f2-modules.md §9).
 *
 * Senza JWT admin risponde solo `{ status }`: 'ok', 'degraded' o 'down'
 * (HTTP 200, oppure 503 se 'down'), senza dettagli che descrivano lo stack.
 * Con un JWT admin valido (stesse regole di authMiddleware, senza rinnovo del
 * cookie) aggiunge il dettaglio per la pagina "Salute del calendario" e per
 * gli alert: modo e store, motivi dello stato, configurazione di Radicale,
 * control-plane (policy e heartbeat), identità del volume, campanello e
 * canary, collezioni con lag e salute, quarantene, hold, orizzonte, job,
 * conflitti di prenotazione aperti, rebuild e modalità degradata.
 *
 * Regole dello stato:
 *  - 'down' se il calendario non può servire adesso: stato del backend
 *    illeggibile (database); con lo store Radicale anche Radicale non
 *    configurato, identità del volume non 'ok', campanello fermo, una
 *    collezione bloccante 'unsyncable' oltre i 10 minuti del livello display,
 *    orizzonte più corto della garanzia statica (le stesse condizioni che
 *    portano /slots in 503, design §7);
 *  - 'degraded' se funziona con disponibilità ridotta o qualcosa va guardato:
 *    remote mode, collezioni stale/hold/unsyncable entro la tolleranza,
 *    oggetti in quarantena, rebuild richiesto, freeze o transizione, job
 *    morti o in ritardo, conflitti aperti, control-plane che fallisce,
 *    identità non 'ok' in shadow, modalità degradata accesa;
 *  - in mode postgres (produzione dopo il deploy della F2) i componenti di
 *    Radicale lavorano in shadow: sono riportati ma non portano mai a 'down',
 *    e un Radicale non configurato è dichiarato 'not_configured' senza
 *    essere un errore. Un singolo oggetto in quarantena non porta mai a
 *    'down'.
 *
 * Nessuna richiesta a Radicale: si riportano gli ultimi esiti di watcher,
 * canary, control-plane e verifica d'identità. Ogni sezione è isolata (un
 * errore diventa `{ error }` e porta a 'degraded'), con un timeout; l'esito è
 * in cache per pochi secondi con single-flight, perché la versione pubblica
 * non ha autenticazione.
 */

import { Hono } from 'hono';
import type { Context } from 'hono';
import { jwtVerify } from 'jose';
import { sql } from '../../db';
import { ABSOLUTE_SESSION_MS, getJwtSecret } from '../../lib/jwt';
import { extractToken } from '../../middleware/auth';
import { logger } from '../../lib/logger';
import { readBackendStateFresh, storeKindForMode } from '../../lib/calendar/backend-mode';
import { getDegradedBookingMode } from '../../lib/calendar/busy';
import { requiredHorizonEnd } from '../../lib/calendar/index-model';
import { calendarJobStats, type CalendarJobStats } from '../../lib/calendar/jobs';
import { type CanaryResult, lastCanaryResult } from '../../lib/calendar/radicale/canary';
import { blocksDecisions, getIndexHealth, type IndexHealthSummary } from '../../lib/calendar/radicale/health';
import { type ControlPlaneStatus, getCalendarControlPlane } from '../../lib/calendar/radicale/heartbeat';
import { maxAdvanceDays } from '../../lib/calendar/radicale/horizon';
import { lastIdentityCheck, radicaleRuntime } from '../../lib/calendar/radicale/sync';
import type { CalendarBackendState } from '../../lib/calendar/radicale/types';
import { getWatcherStatus, watcherAlive, type WatcherStatus } from '../../lib/calendar/radicale/watcher';

const log = logger.child({ scope: 'calendar-health' });

export const calendarHealth = new Hono();

export type CalendarHealthStatus = 'ok' | 'degraded' | 'down';

/** Validità dell'esito in cache (la versione pubblica non ha autenticazione). */
const CACHE_MS = 5_000;
/** Timeout di ogni sezione del controllo. */
const SECTION_TIMEOUT_MS = 5_000;
/** Job pending maturi da più di così: backlog (degraded). */
const JOB_BACKLOG_DEGRADED_S = 600;
/** Inattività massima della sessione admin (come authMiddleware). */
const SESSION_IDLE_MS = 30 * 60_000;
/** Oggetti in quarantena elencati nel dettaglio (il conteggio resta completo). */
const QUARANTINE_DETAIL_LIMIT = 100;

/** Esito di una sezione: valore o errore, mai un'eccezione. */
type Section<T> = { ok: true; value: T } | { ok: false; error: string };

async function section<T>(name: string, fn: () => Promise<T>): Promise<Section<T>> {
  let timer: NodeJS.Timeout | undefined;
  try {
    const value = await Promise.race([
      fn(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`timeout dopo ${SECTION_TIMEOUT_MS} ms`)), SECTION_TIMEOUT_MS);
      }),
    ]);
    return { ok: true, value };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.warn({ err, section: name }, 'sezione della salute del calendario non disponibile');
    return { ok: false, error: message.slice(0, 500) };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

interface ConflictSummary {
  open: number;
  oldest_open_at: Date | null;
}

interface RebuildSummary {
  required: boolean;
  pending_jobs: number;
  running_jobs: number;
}

export interface CalendarHealthReport {
  status: CalendarHealthStatus;
  /** Codici stabili dei motivi (per gli alert), nell'ordine di gravità. */
  reasons: Array<{ code: string; severity: 'down' | 'degraded'; message: string }>;
  generated_at: string;
  mode: {
    mode: CalendarBackendState['mode'];
    store: 'postgres' | 'radicale';
    write_freeze: boolean;
    rebuild_required: boolean;
    restore_guard_until: Date | null;
    epoch: number;
    volume_id: string | null;
    policy_version: number;
    credential_epoch: number;
  } | { error: string };
  radicale: {
    status: 'configured' | 'not_configured';
    reason: string | null;
    principal: string;
    data_dir: string;
    watch_setting: string;
    identity_source_setting: string;
  };
  control_plane: ({ status: 'running' | 'stopped' } & ControlPlaneStatus) | { status: 'not_configured' };
  identity: { status: string; source: string | null; detail: string | null; checked_at: string | null; origin: 'sync' | 'control_plane' | null };
  heartbeat: { last_at: string | null; status: 'ok' | 'stale' | 'missing' | 'not_configured' };
  watcher: WatcherStatus & { alive: boolean };
  canary: CanaryResult | { status: 'never_run' };
  collections: Array<IndexHealthSummary['collections'][number] & { lag_seconds: number; since_last_sync_seconds: number | null; blocks_display: boolean }> | { error: string };
  quarantined: { count: number; items: IndexHealthSummary['quarantined']; orphan_overrides: number; unreadable: number; materialized_limited: number } | { error: string };
  hold: Array<{ calendar_id: string; collection_name: string | null; reason: string | null; pending_deletions: number }>;
  horizon: { required_end: Date; max_advance_days: number; short: Array<{ calendar_id: string; collection_name: string | null; horizon_end: Date | null }> } | { error: string };
  jobs: CalendarJobStats | { error: string };
  conflicts: ConflictSummary | { error: string };
  rebuild: RebuildSummary | { error: string };
  degraded_booking_mode: Awaited<ReturnType<typeof getDegradedBookingMode>> | { error: string };
}

/** Ripiego della sezione "modo" se lo stato non si legge: niente store, niente decisioni. */
function isState(v: CalendarHealthReport['mode']): v is Exclude<CalendarHealthReport['mode'], { error: string }> {
  return !('error' in v);
}

/** Calcola il rapporto completo (dettaglio admin; la versione pubblica ne usa solo lo stato). */
export async function computeCalendarHealth(now: Date = new Date()): Promise<CalendarHealthReport> {
  const reasons: CalendarHealthReport['reasons'] = [];
  const down = (code: string, message: string) => reasons.push({ code, severity: 'down', message });
  const degraded = (code: string, message: string) => reasons.push({ code, severity: 'degraded', message });

  const [stateS, indexS, jobsS, conflictsS, rebuildJobsS, advanceS, degradedS] = await Promise.all([
    section('state', () => readBackendStateFresh(sql)),
    section('index', () => getIndexHealth(sql)),
    section('jobs', () => calendarJobStats(sql)),
    section('conflicts', async () => {
      const [row] = await sql<Array<{ open: number; oldest: Date | null }>>`
        SELECT count(*)::int AS open, min(detected_at) AS oldest
        FROM cal_booking_conflicts WHERE resolved_at IS NULL
      `;
      return { open: row?.open ?? 0, oldest_open_at: row?.oldest ?? null } satisfies ConflictSummary;
    }),
    section('rebuild', async () => {
      const [row] = await sql<Array<{ pending: number; running: number }>>`
        SELECT count(*) FILTER (WHERE status = 'pending')::int AS pending,
               count(*) FILTER (WHERE status = 'running')::int AS running
        FROM cal_jobs WHERE kind = 'index_rebuild'
      `;
      return { pending: row?.pending ?? 0, running: row?.running ?? 0 };
    }),
    section('horizon', () => maxAdvanceDays(sql)),
    section('degraded_mode', () => getDegradedBookingMode(sql, now)),
  ]);

  // ── Modo e store ──
  let mode: CalendarHealthReport['mode'];
  if (stateS.ok) {
    const s = stateS.value;
    mode = {
      mode: s.mode,
      store: storeKindForMode(s.mode),
      write_freeze: s.write_freeze,
      rebuild_required: s.rebuild_required,
      restore_guard_until: s.restore_guard_until,
      epoch: s.epoch,
      volume_id: s.volume_id,
      policy_version: s.policy_version,
      credential_epoch: s.credential_epoch,
    };
  } else {
    mode = { error: stateS.error };
    down('state_unreadable', `stato del backend calendario illeggibile: ${stateS.error}`);
  }
  const radicaleStore = isState(mode) && mode.store === 'radicale';
  if (isState(mode)) {
    if (mode.mode === 'cutover' || mode.mode === 'rollback') degraded('transition', `modo ${mode.mode}: scritture del calendario sospese`);
    if (mode.write_freeze && radicaleStore) degraded('write_freeze', 'write_freeze attivo: scritture del calendario sospese');
    if (mode.rebuild_required) degraded('rebuild_required', 'ricostruzione dell\'indice richiesta o in corso');
    if (mode.restore_guard_until && mode.restore_guard_until.getTime() > now.getTime()) {
      degraded('restore_guard', `guardia di ripristino attiva fino a ${mode.restore_guard_until.toISOString()}`);
    }
  }

  // ── Radicale e control-plane ──
  const rt = radicaleRuntime();
  const configured = rt.client !== null;
  const radicale: CalendarHealthReport['radicale'] = {
    status: configured ? 'configured' : 'not_configured',
    reason: configured ? null : rt.unavailableReason,
    principal: rt.principal,
    data_dir: rt.dataDir,
    watch_setting: rt.watch,
    identity_source_setting: rt.identitySource,
  };
  if (!configured && radicaleStore) down('radicale_not_configured', `store Radicale attivo ma Radicale non configurato: ${rt.unavailableReason ?? 'client assente'}`);

  const plane = getCalendarControlPlane();
  const planeStatus = plane?.status() ?? null;
  const controlPlane: CalendarHealthReport['control_plane'] = planeStatus
    ? { status: planeStatus.running ? 'running' : 'stopped', ...planeStatus }
    : { status: 'not_configured' };
  if (planeStatus && planeStatus.consecutiveFailures > 0) {
    degraded('control_plane_failing', `control-plane: ${planeStatus.consecutiveFailures} giri falliti (${planeStatus.lastTick?.error ?? 'errore sconosciuto'})`);
  }
  const heartbeatAt = planeStatus?.lastHeartbeatAt ?? null;
  const heartbeat: CalendarHealthReport['heartbeat'] = !planeStatus
    ? { last_at: null, status: 'not_configured' }
    : !heartbeatAt
      ? { last_at: null, status: 'missing' }
      : { last_at: heartbeatAt, status: now.getTime() - Date.parse(heartbeatAt) > 2 * 60_000 ? 'stale' : 'ok' };
  if (planeStatus && heartbeat.status !== 'ok') degraded('heartbeat_' + heartbeat.status, `heartbeat dell'API ${heartbeat.status === 'missing' ? 'mai scritto' : 'vecchio'}`);

  // ── Identità del volume: ultima verifica dei moduli SYNC, altrimenti del control-plane ──
  const syncCheck = lastIdentityCheck();
  const planeCheck = planeStatus?.lastTick?.identity ?? null;
  const check = syncCheck ?? planeCheck;
  const identity: CalendarHealthReport['identity'] = check
    ? { status: check.status, source: check.source, detail: check.detail, checked_at: check.checkedAt, origin: syncCheck ? 'sync' : 'control_plane' }
    : { status: configured ? 'unknown' : 'not_configured', source: null, detail: null, checked_at: null, origin: null };
  if (radicaleStore && configured) {
    if (!check) degraded('identity_unknown', 'identità del volume non ancora verificata');
    else if (check.status !== 'ok') down(`identity_${check.status}`, `identità del volume ${check.status}${check.detail ? `: ${check.detail}` : ''}`);
  } else if (check && isState(mode) && mode.epoch > 0 && check.status !== 'ok') {
    // Shadow: policy frozen per i device, nessun effetto sul calendario servito da Postgres.
    degraded(`identity_${check.status}`, `identità del volume ${check.status} (shadow)${check.detail ? `: ${check.detail}` : ''}`);
  }

  // ── Campanello e canary ──
  const watcher = { ...getWatcherStatus(), alive: watcherAlive(now.getTime()) };
  const canaryResult = lastCanaryResult();
  const canary: CalendarHealthReport['canary'] = canaryResult ?? { status: 'never_run' };
  if (radicaleStore && configured) {
    if (!watcher.alive) down('watcher_down', `campanello non attivo (${watcher.reason ?? watcher.mode})`);
    else if (watcher.mode === 'remote') degraded('watcher_remote', `remote mode: disponibilità ridotta (${watcher.reason ?? 'mount non utilizzabile'})`);
    if (canaryResult && !canaryResult.ok) degraded('canary_failed', `canary fallito: ${canaryResult.reason ?? 'sconosciuto'}`);
  }

  // ── Collezioni, quarantene, hold ──
  let collections: CalendarHealthReport['collections'];
  let quarantined: CalendarHealthReport['quarantined'];
  const hold: CalendarHealthReport['hold'] = [];
  if (indexS.ok) {
    const idx = indexS.value;
    collections = idx.collections.map((v) => ({
      ...v,
      lag_seconds: v.dirtySince ? Math.max(0, Math.round((now.getTime() - v.dirtySince.getTime()) / 1000)) : 0,
      since_last_sync_seconds: v.lastSyncedAt ? Math.max(0, Math.round((now.getTime() - v.lastSyncedAt.getTime()) / 1000)) : null,
      blocks_display: blocksDecisions(v, 'display', now),
    }));
    for (const v of collections) {
      const name = v.collectionName ?? v.calendarId;
      if (v.health === 'hold') hold.push({ calendar_id: v.calendarId, collection_name: v.collectionName, reason: v.holdReason, pending_deletions: v.pendingDeletions });
      if (!radicaleStore) continue;
      if (v.blocks_display) down('collection_unsyncable', `collezione bloccante ${name} non sincronizzabile da oltre 10 minuti`);
      else if (v.health === 'unsyncable') degraded('collection_unsyncable', `collezione ${name} non sincronizzabile (${v.lastError ?? 'errore'})`);
      else if (v.health === 'stale') degraded('collection_stale', `collezione ${name} con modifiche non indicizzate`);
      else if (v.health === 'hold') degraded('collection_hold', `collezione ${name} in hold: cancellazioni di massa sospese (${v.pendingDeletions})`);
    }
    quarantined = {
      count: idx.collections.reduce((n, v) => n + v.quarantined, 0),
      items: idx.quarantined.slice(0, QUARANTINE_DETAIL_LIMIT),
      orphan_overrides: idx.orphanOverrides,
      unreadable: idx.unreadable,
      materialized_limited: idx.materializedLimited,
    };
    if (radicaleStore && quarantined.count > 0) degraded('objects_quarantined', `${quarantined.count} oggetti in quarantena`);
    if (radicaleStore && idx.orphanOverrides > 0) degraded('orphan_overrides', `${idx.orphanOverrides} override orfani`);
  } else {
    collections = { error: indexS.error };
    quarantined = { error: indexS.error };
    if (radicaleStore) degraded('index_unreadable', `salute dell'indice non leggibile: ${indexS.error}`);
  }

  // ── Orizzonte (garanzia statica, design §6.9) ──
  let horizon: CalendarHealthReport['horizon'];
  if (advanceS.ok) {
    const requiredEnd = requiredHorizonEnd(now, advanceS.value);
    const short = Array.isArray(collections)
      ? collections
          .filter((v) => v.originStore === 'radicale' && v.blocking && (!v.horizon || v.horizon.end.getTime() < requiredEnd.getTime()))
          .map((v) => ({ calendar_id: v.calendarId, collection_name: v.collectionName, horizon_end: v.horizon?.end ?? null }))
      : [];
    horizon = { required_end: requiredEnd, max_advance_days: advanceS.value, short };
    if (radicaleStore && short.length > 0) down('horizon_insufficient', `${short.length} collezioni bloccanti con orizzonte prima di ${requiredEnd.toISOString()}`);
  } else {
    horizon = { error: advanceS.error };
    if (radicaleStore) degraded('horizon_unknown', `orizzonte non verificabile: ${advanceS.error}`);
  }

  // ── Job, conflitti, rebuild, modalità degradata ──
  let jobs: CalendarHealthReport['jobs'];
  if (jobsS.ok) {
    jobs = jobsS.value;
    if (jobs.dead > 0) degraded('jobs_dead', `${jobs.dead} job del calendario falliti definitivamente`);
    if (jobs.oldestDueAgeSeconds !== null && jobs.oldestDueAgeSeconds > JOB_BACKLOG_DEGRADED_S) degraded('jobs_backlog', `job in attesa da ${jobs.oldestDueAgeSeconds} s`);
    if (jobs.expiredLeases > 0) degraded('jobs_expired_leases', `${jobs.expiredLeases} job con lease scaduto`);
  } else {
    jobs = { error: jobsS.error };
    degraded('jobs_unreadable', `coda dei job non leggibile: ${jobsS.error}`);
  }
  let conflicts: CalendarHealthReport['conflicts'];
  if (conflictsS.ok) {
    conflicts = conflictsS.value;
    if (conflicts.open > 0) degraded('booking_conflicts', `${conflicts.open} conflitti di prenotazione da rivedere`);
  } else {
    conflicts = { error: conflictsS.error };
  }
  const rebuild: CalendarHealthReport['rebuild'] = rebuildJobsS.ok
    ? { required: isState(mode) ? mode.rebuild_required : false, pending_jobs: rebuildJobsS.value.pending, running_jobs: rebuildJobsS.value.running }
    : { error: rebuildJobsS.error };
  let degradedMode: CalendarHealthReport['degraded_booking_mode'];
  if (degradedS.ok) {
    degradedMode = degradedS.value;
    if (degradedMode.active) degraded('degraded_booking_mode', `modalità degradata delle prenotazioni attiva fino a ${degradedMode.expiresAt?.toISOString() ?? '?'}`);
  } else {
    degradedMode = { error: degradedS.error };
  }

  const severity = (r: CalendarHealthReport['reasons'][number]) => (r.severity === 'down' ? 0 : 1);
  reasons.sort((a, b) => severity(a) - severity(b));
  const status: CalendarHealthStatus = reasons.some((r) => r.severity === 'down') ? 'down' : reasons.length > 0 ? 'degraded' : 'ok';

  return {
    status,
    reasons,
    generated_at: now.toISOString(),
    mode,
    radicale,
    control_plane: controlPlane,
    identity,
    heartbeat,
    watcher,
    canary,
    collections,
    quarantined,
    hold,
    horizon,
    jobs,
    conflicts,
    rebuild,
    degraded_booking_mode: degradedMode,
  };
}

// ─── Cache con single-flight ───────────────────────────────

let cached: { at: number; report: CalendarHealthReport } | null = null;
let computing: Promise<CalendarHealthReport> | null = null;

async function currentReport(): Promise<CalendarHealthReport> {
  if (cached && performance.now() - cached.at < CACHE_MS) return cached.report;
  computing ??= computeCalendarHealth()
    .then((report) => {
      cached = { at: performance.now(), report };
      return report;
    })
    .finally(() => {
      computing = null;
    });
  return computing;
}

/** Svuota la cache dell'esito (test). */
export function resetCalendarHealthCache(): void {
  cached = null;
}

// ─── Autenticazione facoltativa ───────────────────────────────

/**
 * true se la richiesta porta un JWT admin valido (cookie o Bearer), con le
 * stesse verifiche di authMiddleware (ruolo admin, inattività di 30 minuti,
 * durata assoluta della sessione) ma senza rinnovare il cookie né rispondere
 * 401: senza JWT valido la salute risponde comunque, solo con lo stato.
 */
export async function isAdminRequest(c: Context): Promise<boolean> {
  const token = extractToken(c);
  if (!token) return false;
  try {
    const { payload } = await jwtVerify(token, getJwtSecret());
    if (!payload.sub || payload.role !== 'admin') return false;
    const lastActivity = payload.last_activity as number | undefined;
    if (lastActivity && Date.now() - lastActivity > SESSION_IDLE_MS) return false;
    const authAt = payload.auth_at as number | undefined;
    if (authAt && Date.now() - authAt > ABSOLUTE_SESSION_MS) return false;
    return true;
  } catch {
    return false;
  }
}

calendarHealth.get('/', async (c) => {
  const admin = await isAdminRequest(c);
  const report = await currentReport();
  const httpStatus = report.status === 'down' ? 503 : 200;
  c.header('Cache-Control', 'no-store');
  if (!admin) return c.json({ status: report.status }, httpStatus);
  return c.json(report, httpStatus);
});
