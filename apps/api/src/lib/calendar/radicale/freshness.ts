/**
 * Freschezza dell'indice per le decisioni di prenotazione e prontezza del
 * livello display (fase F2 del passaggio a Radicale; design §6.1, §6.5, §7,
 * §9; contratto dei moduli f2-modules.md §4.5).
 *
 * Livello decision (verifyFreshness), dentro la sezione critica di
 * createBooking/rescheduleBooking, con il `db` della transazione (stato letto
 * senza cache, READ COMMITTED: la query di busy successiva vede la COMMIT
 * delle sync appena fatte). Budget 2,5 s:
 *  - identità del volume `ok` (altrimenti 503 identity_*);
 *  - mount affidabile: principal cambiato rispetto all'ultima discovery →
 *    discovery (una collezione nuova creata da un device blocca, decisione
 *    4); per ogni collezione del set (Radicale-backed bloccanti + bookings,
 *    mai le iscrizioni) `stat(dir) == dir_mtime_ns` → ok senza HTTP;
 *    directory cambiata o dir_mtime_ns NULL (rebuild, racy, mai
 *    sincronizzata) → syncCollection single-flight entro la scadenza;
 *  - remote mode: budget stimato dalle dimensioni (circa 0,6 s ogni 5000
 *    item, oltre 2 s → 503 remote_budget_exceeded), poi PROPFIND Depth:0 del
 *    sync-token di ogni collezione e sync di quelle cambiate;
 *  - timeout, errore, collezione bloccante non sincronizzabile → 503.
 * Con Radicale fermo e nessuna modifica pendente la mtime non cambia: nessuna
 * richiesta HTTP, la prenotazione prosegue (design §9). Una collezione in hold
 * non produce mai 503 (le sue occorrenze continuano a bloccare).
 *
 * Livello display (assertDisplayReady), per /slots e i tool in lettura:
 * campanello vivo, identità `ok`, orizzonte sufficiente, nessuna collezione
 * bloccante unsyncable da oltre 10 minuti. Un singolo oggetto in quarantena
 * non produce mai 503 (invariante 2).
 *
 * Mode postgres: le decisioni usano il busy legacy; le due funzioni non
 * fanno nulla (lo store forzato dai test con overrideCalendarStore vale come
 * modo).
 */

import type { Logger } from 'pino';
import { calSql } from '../../../db';
import { logger as rootLogger } from '../../logger';
import { readBackendStateCached, readBackendStateFresh, storeKindForMode, storeKindOverride } from '../backend-mode';
import { CalendarUnavailableError, type CalendarUnavailableReason } from '../errors';
import { INDEX_TIMING, requiredHorizonEnd } from '../index-model';
import { collectionPath } from './client';
import { DAV_PROPS, clark } from './dav-xml';
import { discoverCollections, lastDiscovery } from './discovery';
import { isRadicaleError } from './errors';
import { blocksDecisions, listCollectionHealth } from './health';
import type { Db } from './policy';
import { CollectionSyncError, currentWatchMode, markCollectionDirty, radicaleRuntime, syncCollection, verifyVolumeIdentity, type WatchMode } from './sync';
import type { CalendarBackendState } from './types';
import { isValidCollectionName } from './types';
import { statCollectionDir, statPrincipal, watcherAlive } from './watcher';

const log: Logger = rootLogger.child({ scope: 'calendar-freshness' });

// ─── Tipi del contratto (f2-modules §4.5) ───────────────────

export interface FreshnessReport {
  mode: WatchMode;
  /** Collezioni del set verificate. */
  checked: number;
  /** Collezioni sincronizzate durante la verifica. */
  synced: string[];
  /** È stata fatta una discovery (principal cambiato). */
  discovery: boolean;
  durationMs: number;
}

/** Costo stimato a caldo di una PROPFIND del sync-token ogni 5000 item (design §6.1). */
const REMOTE_COST_PER_5000_MS = 600;
/** Costo fisso stimato di una PROPFIND Depth:0. */
const REMOTE_BASE_COST_MS = 20;

// ─── Set di freschezza ───────────────────

/**
 * Collezioni del set di freschezza: Radicale-backed (mai le iscrizioni, la cui
 * fonte è il feed remoto) attive e bloccanti, più bookings (i suoi item non di
 * proiezione bloccano come oggi), più il principal (discovery).
 */
export async function decisionFreshnessSet(db: Db): Promise<{ calendarIds: string[]; includePrincipal: true }> {
  const rows: Array<{ id: string; collection_name: string | null }> = await db`
    SELECT id, collection_name FROM calendars
    WHERE lifecycle = 'active' AND role <> 'subscription' AND collection_name IS NOT NULL
      AND (blocks_availability OR role = 'bookings')
    ORDER BY sort_order, collection_name
  `;
  return {
    calendarIds: rows.filter((r) => isValidCollectionName(r.collection_name)).map((r) => String(r.id).toLowerCase()),
    includePrincipal: true,
  };
}

// ─── Utilità ───────────────────

function unavailable(reason: CalendarUnavailableReason, detail: string, cause?: unknown): CalendarUnavailableError {
  return new CalendarUnavailableError(reason, detail, cause === undefined ? undefined : { cause });
}

/** Attende `promise` entro la scadenza; oltre → 503 freshness_timeout. */
async function withinDeadline<T>(promise: Promise<T>, deadline: number, what: string): Promise<T> {
  const ms = deadline - Date.now();
  if (ms <= 0) throw unavailable('freshness_timeout', `${what}: budget esaurito`);
  let timer: NodeJS.Timeout | null = null;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(unavailable('freshness_timeout', `${what}: oltre il budget`)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function identityError(status: string, detail: string | null): CalendarUnavailableError {
  return unavailable(status === 'mismatch' ? 'identity_mismatch' : 'identity_unverified', `identità del volume ${status}${detail ? `: ${detail}` : ''}`);
}

/** Errore di una sync della freshness → motivo del 503. */
function syncFailure(err: unknown, state: CalendarBackendState): CalendarUnavailableError {
  if (err instanceof CalendarUnavailableError) return err;
  if (err instanceof CollectionSyncError) {
    switch (err.code) {
      case 'identity':
        return unavailable('identity_unverified', err.message, err);
      case 'not_configured':
        return unavailable('radicale_unreachable', err.message, err);
      case 'timeout':
      case 'lock_timeout':
      case 'aborted':
        return unavailable('freshness_timeout', err.message, err);
      default:
        break;
    }
  }
  const detail = (err as Error)?.message ?? String(err);
  return unavailable(state.rebuild_required ? 'rebuild_in_progress' : 'collection_unsyncable', detail, err);
}

const FAILURE_PRIORITY: Record<string, number> = {
  identity_mismatch: 0,
  identity_unverified: 1,
  radicale_unreachable: 2,
  rebuild_in_progress: 3,
  collection_unsyncable: 4,
  freshness_timeout: 5,
};

// ─── Livello decision ───────────────────

interface SetRow {
  id: string;
  collection_name: string;
  dir_mtime_ns: string | null;
  sync_token: string | null;
  health: string | null;
  object_count: number | null;
}

/**
 * Verifica che l'indice rifletta Radicale per le collezioni che decidono il
 * busy (vedi testa del file). Lancia CalendarUnavailableError (503) con il
 * motivo; restituisce il resoconto se le decisioni possono procedere.
 */
export async function verifyFreshness(opts: { db: Db; budgetMs?: number; signal?: AbortSignal }): Promise<FreshnessReport> {
  const startedAt = performance.now();
  const budget = opts.budgetMs ?? INDEX_TIMING.freshnessBudgetMs;
  const deadline = Date.now() + budget;
  const { db, signal } = opts;
  const report = (mode: WatchMode, checked: number, synced: string[], discovery: boolean): FreshnessReport => ({
    mode, checked, synced, discovery, durationMs: Math.round(performance.now() - startedAt),
  });

  const state = await readBackendStateFresh(db);
  const kind = storeKindOverride() ?? storeKindForMode(state.mode);
  if (kind === 'postgres') return report('off', 0, [], false);

  const rt = radicaleRuntime();
  const client = rt.client;
  if (!client) throw unavailable('radicale_unreachable', rt.unavailableReason ?? 'Radicale non configurato');
  if (signal?.aborted) throw unavailable('freshness_timeout', 'verifica interrotta');

  const { check } = await withinDeadline(verifyVolumeIdentity({ state }), deadline, 'identità del volume');
  if (check.status !== 'ok') throw identityError(check.status, check.detail);

  const mode = currentWatchMode().mode === 'mount' ? 'mount' : 'remote';
  let discovery = false;
  if (mode === 'mount') {
    let principalMtime: bigint | null;
    try {
      principalMtime = (await statPrincipal()).dirMtimeNs;
    } catch (err) {
      throw unavailable('watcher_down', `stat del principal non riuscita: ${(err as Error).message}`, err);
    }
    if (principalMtime === null) throw identityError('unverified', 'principal assente sul mount');
    const last = lastDiscovery();
    if (!last || last.principalMtimeNs !== principalMtime.toString()) {
      try {
        const res = await withinDeadline(discoverCollections(), deadline, 'discovery');
        if (res.identity !== 'ok') throw identityError(res.identity, null);
        discovery = true;
      } catch (err) {
        if (err instanceof CalendarUnavailableError) throw err;
        throw unavailable('radicale_unreachable', `discovery non riuscita: ${(err as Error).message}`, err);
      }
    }
  }

  const set = await decisionFreshnessSet(db);
  const rows: SetRow[] = set.calendarIds.length
    ? await db`
        SELECT c.id, c.collection_name, s.dir_mtime_ns::text AS dir_mtime_ns, s.sync_token, s.health, s.object_count
        FROM calendars c
        LEFT JOIN cal_collection_state s ON s.calendar_id = c.id
        WHERE c.id = ANY(${set.calendarIds}::uuid[])
      `
    : [];

  const toSync: string[] = [];
  /** mtime osservata delle collezioni da sincronizzare (mount mode). */
  const observedMtime = new Map<string, bigint>();
  if (mode === 'mount') {
    for (const row of rows) {
      let m: bigint | null;
      try {
        m = await statCollectionDir(row.collection_name);
      } catch (err) {
        throw unavailable('watcher_down', `stat della collezione ${row.collection_name} non riuscita: ${(err as Error).message}`, err);
      }
      if (m === null) {
        // Collezione sparita: già in hold (le occorrenze bloccano) oppure da mettere in hold.
        if (row.health !== 'hold') toSync.push(row.id);
        continue;
      }
      if (row.dir_mtime_ns === null || BigInt(row.dir_mtime_ns) !== m) {
        toSync.push(row.id);
        observedMtime.set(row.id, m);
      }
    }
  } else {
    const estimate = rows.reduce((acc, r) => acc + REMOTE_BASE_COST_MS + ((r.object_count ?? 0) / 5_000) * REMOTE_COST_PER_5000_MS, 0);
    if (estimate > INDEX_TIMING.remoteDecisionBudgetMs) {
      throw unavailable('remote_budget_exceeded', `remote mode: verifica stimata ${Math.round(estimate)} ms, oltre ${INDEX_TIMING.remoteDecisionBudgetMs} ms`);
    }
    const remoteDeadline = Math.min(deadline, Date.now() + INDEX_TIMING.remoteDecisionBudgetMs);
    const tokens = await Promise.all(rows.map(async (row) => {
      const timeoutMs = remoteDeadline - Date.now();
      if (timeoutMs <= 0) throw unavailable('remote_budget_exceeded', 'remote mode: budget delle PROPFIND esaurito');
      try {
        const props = await client.readProps(collectionPath(rt.principal, row.collection_name), [DAV_PROPS.syncToken], { timeoutMs });
        return props === null ? null : props[clark(DAV_PROPS.syncToken)] ?? '';
      } catch (err) {
        if (isRadicaleError(err, 'timeout')) throw unavailable('remote_budget_exceeded', `PROPFIND di ${row.collection_name} oltre il budget`, err);
        throw unavailable('radicale_unreachable', `PROPFIND di ${row.collection_name}: ${(err as Error).message}`, err);
      }
    }));
    rows.forEach((row, i) => {
      const token = tokens[i];
      if (token === null) {
        if (row.health !== 'hold') toSync.push(row.id);
      } else if (token !== row.sync_token) {
        toSync.push(row.id);
      }
    });
  }

  if (toSync.length) {
    const observedAt = new Date();
    // dirty_since prima della sync: se fallisce la collezione è unsyncable
    // (pool calendario, autocommit: mai righe di stato bloccate nella tx della
    // prenotazione). Entro il budget: l'UPSERT può attendere una connessione
    // del pool calendario o il FOR UPDATE di un apply lungo mentre la
    // prenotazione tiene il lock cal-week. Allo scadere si prosegue (le sync
    // falliscono da sole entro la scadenza) e il segno finisce in background:
    // un segno arrivato dopo un fallimento porta comunque a 'unsyncable'.
    const marks = Promise.all(toSync.map((id) => markCollectionDirty(calSql, id, observedAt, { mtimeNs: observedMtime.get(id) ?? null }).catch((err: unknown) => {
      log.warn({ err, calendarId: id }, 'markCollectionDirty non riuscita');
    })));
    await withinDeadline(marks, deadline, 'marcatura delle modifiche').catch((err: unknown) => {
      log.warn({ err: (err as Error)?.message }, 'marcatura delle modifiche oltre il budget: si prosegue con le sync');
    });
    const results = await Promise.allSettled(toSync.map((id) => syncCollection(id, { reason: 'freshness', deadline, signal })));
    const failures = results
      .map((r, i) => (r.status === 'rejected' ? { id: toSync[i], error: syncFailure(r.reason, state) } : null))
      .filter((f): f is { id: string; error: CalendarUnavailableError } => f !== null);
    if (failures.length) {
      failures.sort((a, b) => (FAILURE_PRIORITY[a.error.reason] ?? 9) - (FAILURE_PRIORITY[b.error.reason] ?? 9));
      log.warn({ failures: failures.map((f) => ({ calendarId: f.id, reason: f.error.reason, detail: f.error.detail })) }, 'freshness delle decisioni non verificata: 503');
      throw failures[0].error;
    }
  }
  return report(mode, rows.length, toSync, discovery);
}

// ─── Livello display ───────────────────

/**
 * Prontezza per la sola visualizzazione (/slots, cal-slots, find_free_slots,
 * get_calendar_availability): campanello vivo, identità `ok`, orizzonte
 * sufficiente, nessuna collezione bloccante unsyncable da oltre 10 minuti.
 * Lancia CalendarUnavailableError (503).
 */
export async function assertDisplayReady(db: Db): Promise<void> {
  const state = await readBackendStateCached(db);
  const kind = storeKindOverride() ?? storeKindForMode(state.mode);
  if (kind === 'postgres') return;
  const rt = radicaleRuntime();
  if (!rt.client) throw unavailable('radicale_unreachable', rt.unavailableReason ?? 'Radicale non configurato');
  if (!watcherAlive()) throw unavailable('watcher_down', 'campanello del calendario fermo');
  const { check } = await verifyVolumeIdentity({ state });
  if (check.status !== 'ok') throw identityError(check.status, check.detail);

  const { assertHorizonCovers, maxAdvanceDays } = await import('./horizon');
  const now = new Date();
  await assertHorizonCovers(db, requiredHorizonEnd(now, await maxAdvanceDays(db)));

  const views = await listCollectionHealth(db, { now });
  const blocked = views.find((v) => v.originStore === 'radicale' && blocksDecisions(v, 'display', now));
  if (blocked) {
    throw unavailable('collection_unsyncable', `collezione ${blocked.collectionName ?? blocked.calendarId} non sincronizzabile da ${blocked.healthSince.toISOString()}`);
  }
}
