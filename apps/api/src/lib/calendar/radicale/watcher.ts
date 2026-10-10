/**
 * Campanello del calendario: si accorge che Radicale è cambiato e fa partire
 * la sync (fase F2 del passaggio a Radicale; design §6.1, contratto dei moduli
 * f2-modules.md §4.1). Nessun plugin di storage né hook in Radicale: l'API
 * monta il volume delle collezioni in sola lettura (RADICALE_DATA_DIR) e fa
 * `stat` delle directory.
 *
 * Modalità `mount` (stat affidabile, confermata dal canary), ogni secondo:
 *  - directory del principal cambiata (MKCALENDAR, MOVE, DELETE di una
 *    collezione, PROPPATCH del principal) → discovery;
 *  - `.Radicale.props` del principal cambiato → controllo d'identità (e giro
 *    immediato del control-plane se l'esito cambia);
 *  - directory di una collezione Radicale-backed diversa dall'ultima
 *    dir_mtime_ns sincronizzata → markCollectionDirty e syncCollection
 *    (senza attenderla); props della collezione cambiate → discovery.
 *   Verificato su Radicale 3.7.8: la mtime della directory cambia con
 *   MKCALENDAR, PUT, PROPPATCH, MOVE e DELETE, non con GET, PROPFIND e REPORT.
 *
 * Modalità `remote` (mount assente o non affidabile, dichiarata con alert):
 * ogni 30 s PROPFIND Depth:1 sul principal con i sync-token (discovery) e sync
 * delle collezioni con token diverso da quello salvato (o con oggetti in
 * pending_404 da riconfermare).
 *
 * Modalità `off`: CALDES_WATCH=off o Radicale non configurato. Con l'identità
 * del volume diversa da `ok` il campanello resta in pausa (stato `off` con il
 * motivo) e riprova a ogni cambio delle props del principal.
 *
 * Le collezioni seguite sono quelle del sidecar con ruolo diverso da
 * `subscription` (la loro fonte è il feed remoto, design §6.6), lifecycle
 * `active` e nome valido (mai `_*`). Il ciclo non lancia mai: gli errori si
 * contano (consecutiveErrors) e producono un alert al primo di una serie.
 * Letture sul pool principale (il campanello non è nella sezione critica
 * delle prenotazioni); le sync usano il pool calendario.
 */

import { join } from 'node:path';
import type { Logger } from 'pino';
import { sql } from '../../../db';
import { logger as rootLogger } from '../../logger';
import { readBackendStateCached } from '../backend-mode';
import { INDEX_TIMING } from '../index-model';
import type { RadicaleClient } from './client';
import { discoverCollections, lastDiscovery } from './discovery';
import { raiseIndexAlert } from './health';
import {
  collectionDirPath,
  configureRadicaleRuntime,
  currentWatchMode,
  drainSyncs,
  markCollectionDirty,
  onSyncSettled,
  onWatchModeChange,
  principalDirPath,
  radicaleRuntime,
  statMtimeNs,
  syncCollection,
  updateWatchMode,
  verifyVolumeIdentity,
  type WatchMode,
} from './sync';
import { type IdentityStatus, isValidCollectionName, principalPropsPath, RADICALE_PROPS_FILE } from './types';

export type { WatchMode } from './sync';

const log: Logger = rootLogger.child({ scope: 'calendar-watcher' });

// ─── Tipi del contratto (f2-modules §4.1) ───────────────────

export interface WatcherStatus {
  mode: WatchMode;
  running: boolean;
  reason: string | null;
  lastTickAt: Date | null;
  lastChangeAt: Date | null;
  consecutiveErrors: number;
  collections: Array<{ calendarId: string; name: string; dirMtimeNs: string | null; dirtySince: Date | null }>;
}

// ─── Stato ───────────────────

interface Entry {
  calendarId: string;
  name: string;
  /** Ultima mtime osservata (undefined: mai osservata). */
  observed: bigint | null | undefined;
  /** dir_mtime_ns dell'ultima sync riuscita (dal DB o dall'esito della sync). */
  synced: bigint | null;
  /** mtime per cui è partita l'ultima sync (undefined: nessuna). */
  triggered: bigint | null | undefined;
  /** Ultimo sync-token visto in remote mode (undefined: mai). */
  remoteToken: string | null | undefined;
  /** mtime delle props della collezione (undefined: mai osservata). */
  propsMtime: bigint | null | undefined;
  dirtySince: Date | null;
  dirtyMarked: boolean;
  inFlight: boolean;
  failures: number;
  nextRetryAt: number;
}

/** Rilettura dell'elenco delle collezioni dal DB. */
const ENTRIES_REFRESH_MS = 10_000;
/** Pausa massima fra due tentativi su una collezione che fallisce. */
const MAX_RETRY_DELAY_MS = 60_000;
/** Pausa massima fra due discovery fallite. */
const MAX_DISCOVERY_DELAY_MS = 60_000;

/**
 * Orologio monotono per gli intervalli interni (giro, pause dei tentativi,
 * rilettura dell'elenco, discovery, poll remoto): un salto dell'ora di sistema
 * (NTP all'indietro, o l'orologio fermo dei test) non deve sospendere i
 * tentativi né la scoperta delle collezioni nuove. Le date (ultimo giro,
 * ultimo cambio, dirty_since) restano sull'ora di sistema.
 */
const mono = (): number => performance.now();

const w = {
  running: false,
  timer: null as NodeJS.Timeout | null,
  intervalMs: INDEX_TIMING.watcherIntervalMs as number,
  remotePollMs: INDEX_TIMING.remotePrincipalPollMs as number,
  ticking: null as Promise<void> | null,
  lastTickAt: null as Date | null,
  /** Istante monotono dell'ultimo giro (watcherAlive). */
  lastTickMono: 0,
  lastChangeAt: null as Date | null,
  consecutiveErrors: 0,
  entries: new Map<string, Entry>(),
  entriesLoadedAt: Number.NEGATIVE_INFINITY,
  entriesStale: true,
  principalDir: undefined as bigint | null | undefined,
  principalProps: undefined as bigint | null | undefined,
  identity: null as IdentityStatus | null,
  paused: null as string | null,
  lastRemotePollAt: Number.NEGATIVE_INFINITY,
  discovering: null as Promise<void> | null,
  discoveryFailures: 0,
  nextDiscoveryAt: 0,
  unsubscribe: [] as Array<() => void>,
};

// ─── Mount ───────────────────

/** mtime (ns) della directory di una collezione via mount; null se assente o senza mount. */
export async function statCollectionDir(collectionName: string): Promise<bigint | null> {
  return statMtimeNs(collectionDirPath(collectionName));
}

/** mtime (ns) della directory del principal e del suo `.Radicale.props` (null se assenti). */
export async function statPrincipal(): Promise<{ dirMtimeNs: bigint | null; propsMtimeNs: bigint | null }> {
  const rt = radicaleRuntime();
  const [dirMtimeNs, propsMtimeNs] = await Promise.all([
    statMtimeNs(principalDirPath(rt)),
    statMtimeNs(principalPropsPath(rt.dataDir, rt.principal)),
  ]);
  return { dirMtimeNs, propsMtimeNs };
}

// ─── Modalità ───────────────────

/**
 * Imposta la modalità del campanello (la usa canary.ts). CALDES_WATCH=remote
 * impedisce `mount`, CALDES_WATCH=off impedisce tutto tranne `off`. Il
 * passaggio a `remote` è una disponibilità ridotta: alert.
 */
export function setWatchMode(mode: WatchMode, reason: string | null): void {
  const rt = radicaleRuntime();
  let target = mode;
  let why = reason;
  if (rt.watch === 'off' && target !== 'off') {
    target = 'off';
    why = 'disattivato (CALDES_WATCH=off)';
  } else if (rt.watch === 'remote' && target === 'mount') {
    target = 'remote';
    why = 'CALDES_WATCH=remote';
  }
  const previous = currentWatchMode();
  if (!updateWatchMode(target, why)) return;
  if (target === 'remote') {
    raiseIndexAlert('watch-remote', `Campanello del calendario in remote mode (disponibilità ridotta): ${why ?? 'motivo sconosciuto'}`, { key: why ?? '', reason: why ?? undefined, setting: rt.watch });
  } else if (target === 'mount' && previous.mode !== 'mount') {
    log.info({ previous: previous.mode, previousReason: previous.reason }, 'campanello del calendario sul mount');
  } else if (target === 'off') {
    log.info({ reason: why }, 'campanello del calendario spento');
  }
}

// ─── Ciclo ───────────────────

function schedule(delay: number): void {
  if (!w.running) return;
  w.timer = setTimeout(() => {
    w.timer = null;
    w.ticking = tick().finally(() => {
      w.ticking = null;
    });
  }, Math.max(0, delay));
  w.timer.unref?.();
}

async function tick(): Promise<void> {
  if (!w.running) return;
  const started = mono();
  try {
    const mode = currentWatchMode().mode;
    if (mode === 'mount') await mountTick();
    else if (mode === 'remote' && mono() - w.lastRemotePollAt >= w.remotePollMs) {
      w.lastRemotePollAt = mono();
      await remoteTick();
    }
    w.lastTickAt = new Date();
    w.lastTickMono = mono();
    if (w.consecutiveErrors > 0) log.info({ errors: w.consecutiveErrors }, 'campanello del calendario di nuovo regolare');
    w.consecutiveErrors = 0;
  } catch (err) {
    w.consecutiveErrors++;
    w.lastTickAt = new Date();
    w.lastTickMono = mono();
    if (w.consecutiveErrors === 1) {
      raiseIndexAlert('watcher-error', `Campanello del calendario in errore: ${(err as Error)?.message ?? String(err)}`, { key: (err as NodeJS.ErrnoException)?.code ?? 'error' });
    } else {
      log.debug({ err, errors: w.consecutiveErrors }, 'giro del campanello non riuscito');
    }
  } finally {
    schedule(w.intervalMs - (mono() - started));
  }
}

/** Pausa per identità non verificata: stato `off` nella salute, riprova al prossimo cambio. */
function noteIdentity(status: IdentityStatus): boolean {
  w.identity = status;
  const paused = status === 'ok' ? null : `identità del volume ${status}`;
  if (paused !== w.paused) {
    w.paused = paused;
    if (paused) log.warn({ status }, 'campanello in pausa: identità del volume non verificata');
    else log.info('identità del volume verificata: campanello attivo');
  }
  return status === 'ok';
}

async function mountTick(): Promise<void> {
  const principal = await statPrincipal();
  // Identità: rilettura forzata a ogni cambio delle props del principal.
  const state = await readBackendStateCached(sql);
  const force = principal.propsMtimeNs !== w.principalProps;
  w.principalProps = principal.propsMtimeNs;
  const { check } = await verifyVolumeIdentity({ state, force });
  if (!noteIdentity(check.status)) return;

  // Principal cambiato rispetto all'ultima discovery → discovery.
  if (principal.dirMtimeNs !== w.principalDir) {
    if (w.principalDir !== undefined) w.lastChangeAt = new Date();
    w.principalDir = principal.dirMtimeNs;
  }
  const last = lastDiscovery();
  const known = last?.principalMtimeNs ?? null;
  if (principal.dirMtimeNs !== null && (last === null || known !== principal.dirMtimeNs.toString())) requestDiscovery();

  await refreshEntries();
  for (const entry of w.entries.values()) await checkEntry(entry);
}

async function checkEntry(entry: Entry): Promise<void> {
  const dir = collectionDirPath(entry.name);
  const m = await statMtimeNs(dir);
  const now = mono();
  if (m !== entry.observed) {
    if (entry.observed !== undefined) w.lastChangeAt = new Date();
    entry.observed = m;
    // Props della collezione cambiate (displayname, colore, dead prop) → discovery.
    if (m !== null) {
      const props = await statMtimeNs(join(dir, RADICALE_PROPS_FILE));
      if (entry.propsMtime !== undefined && props !== entry.propsMtime) requestDiscovery();
      entry.propsMtime = props;
    }
  }

  if (m === null) {
    // Collezione sparita: una sync per episodio (va in hold, nessuna
    // cancellazione), ripetuta con la pausa crescente se fallisce (es.
    // Radicale fermo): altrimenti la collezione resterebbe unsyncable.
    if (!entry.inFlight && (entry.triggered !== null || (entry.failures > 0 && now >= entry.nextRetryAt))) trigger(entry, null, 'watcher');
    return;
  }
  const dirty = entry.synced === null || m !== entry.synced;
  if (!dirty) {
    entry.dirtyMarked = false;
    entry.dirtySince = null;
    entry.failures = 0;
    return;
  }
  if (!entry.dirtyMarked) {
    entry.dirtyMarked = true;
    entry.dirtySince ??= new Date();
    // Con la mtime osservata: se nel frattempo una sync l'ha già salvata (segno tardivo) non sporca nulla.
    void markCollectionDirty(sql, entry.calendarId, new Date(), { mtimeNs: m }).catch((err: unknown) => log.warn({ err, calendarId: entry.calendarId }, 'markCollectionDirty non riuscita'));
  }
  if (!entry.inFlight && (entry.triggered !== m || now >= entry.nextRetryAt)) {
    trigger(entry, m, entry.triggered === undefined ? 'startup' : 'watcher');
  }
}

function trigger(entry: Entry, mtime: bigint | null, reason: 'watcher' | 'startup' | 'remote-poll'): void {
  entry.inFlight = true;
  entry.triggered = mtime;
  syncCollection(entry.calendarId, { reason })
    .then((res) => {
      entry.synced = res.dirMtimeNs === null ? null : BigInt(res.dirMtimeNs);
      entry.failures = 0;
      // dir_mtime_ns NULL (finestra racy): si riprova al prossimo giro.
      entry.nextRetryAt = 0;
      if (res.syncToken) entry.remoteToken = res.syncToken;
    })
    .catch((err: { code?: string }) => {
      entry.failures++;
      entry.nextRetryAt = mono() + Math.min(MAX_RETRY_DELAY_MS, 1_000 * 2 ** Math.min(entry.failures - 1, 6));
      if (err?.code === 'identity') w.principalProps = undefined; // forza il controllo d'identità
    })
    .finally(() => {
      entry.inFlight = false;
    });
}

function requestDiscovery(): void {
  if (w.discovering || mono() < w.nextDiscoveryAt) return;
  w.discovering = discoverCollections()
    .then((res) => {
      w.discoveryFailures = 0;
      w.nextDiscoveryAt = 0;
      if (res.created.length || res.adopted.length || res.missing.length || res.reappeared.length) w.entriesStale = true;
    })
    .catch((err: unknown) => {
      w.discoveryFailures++;
      w.nextDiscoveryAt = mono() + Math.min(MAX_DISCOVERY_DELAY_MS, 1_000 * 2 ** Math.min(w.discoveryFailures - 1, 6));
      if (w.discoveryFailures === 1) log.warn({ err }, 'discovery delle collezioni non riuscita');
    })
    .finally(() => {
      w.discovering = null;
    });
}

interface EntryRow {
  id: string;
  collection_name: string | null;
  dir_mtime_ns: string | null;
  dirty_since: Date | null;
}

async function refreshEntries(force = false): Promise<void> {
  if (!force && !w.entriesStale && mono() - w.entriesLoadedAt < ENTRIES_REFRESH_MS) return;
  const rows: EntryRow[] = await sql`
    SELECT c.id, c.collection_name, s.dir_mtime_ns::text AS dir_mtime_ns, s.dirty_since
    FROM calendars c
    LEFT JOIN cal_collection_state s ON s.calendar_id = c.id
    WHERE c.role <> 'subscription' AND c.lifecycle = 'active' AND c.collection_name IS NOT NULL
  `;
  const seen = new Set<string>();
  for (const row of rows) {
    if (!isValidCollectionName(row.collection_name)) continue;
    const id = String(row.id).toLowerCase();
    seen.add(id);
    const synced = row.dir_mtime_ns === null ? null : BigInt(row.dir_mtime_ns);
    const entry = w.entries.get(id);
    if (!entry) {
      w.entries.set(id, {
        calendarId: id,
        name: row.collection_name as string,
        observed: undefined,
        synced,
        triggered: undefined,
        remoteToken: undefined,
        propsMtime: undefined,
        dirtySince: row.dirty_since,
        dirtyMarked: row.dirty_since !== null,
        inFlight: false,
        failures: 0,
        nextRetryAt: 0,
      });
      continue;
    }
    if (entry.name !== row.collection_name) {
      entry.name = row.collection_name as string;
      entry.observed = undefined;
      entry.triggered = undefined;
    }
    if (!entry.inFlight) entry.synced = synced;
    if (row.dirty_since) entry.dirtySince = row.dirty_since;
  }
  for (const id of [...w.entries.keys()]) if (!seen.has(id)) w.entries.delete(id);
  w.entriesLoadedAt = mono();
  w.entriesStale = false;
}

async function remoteTick(): Promise<void> {
  const state = await readBackendStateCached(sql);
  const { check } = await verifyVolumeIdentity({ state });
  if (!noteIdentity(check.status)) return;
  const discovery = await discoverCollections();
  w.discoveryFailures = 0;
  if (discovery.identity !== 'ok') return;
  const tokens = new Map(discovery.collections.map((c) => [c.name, c.syncToken]));
  await refreshEntries(true);
  const ids = [...w.entries.keys()];
  if (!ids.length) return;
  const states: Array<{ calendar_id: string; sync_token: string | null; pending404: number }> = await sql`
    SELECT s.calendar_id, s.sync_token,
           (SELECT count(*) FROM cal_objects o WHERE o.calendar_id = s.calendar_id AND o.health = 'pending_404')::int AS pending404
    FROM cal_collection_state s WHERE s.calendar_id = ANY(${ids}::uuid[])
  `;
  const byId = new Map(states.map((s) => [String(s.calendar_id).toLowerCase(), s]));
  for (const entry of w.entries.values()) {
    if (entry.inFlight) continue;
    const token = tokens.get(entry.name);
    const st = byId.get(entry.calendarId);
    if (token === undefined) {
      // Collezione sparita: una sync per episodio (hold), ripetuta con la pausa crescente se fallisce.
      if (entry.remoteToken !== null || (entry.failures > 0 && mono() >= entry.nextRetryAt)) {
        entry.remoteToken = null;
        trigger(entry, null, 'remote-poll');
      }
      continue;
    }
    if (token !== entry.remoteToken && entry.remoteToken !== undefined) w.lastChangeAt = new Date();
    entry.remoteToken = token;
    // Dopo un fallimento si rispetta la pausa crescente anche in remote mode.
    if (entry.failures > 0 && mono() < entry.nextRetryAt) continue;
    // Token diverso da quello salvato, oppure oggetti in pending_404 da riconfermare.
    if (!st || st.sync_token !== token || st.pending404 > 0) trigger(entry, null, 'remote-poll');
  }
}

// ─── Avvio e arresto ───────────────────

/**
 * Avvia il campanello (idempotente). `client` e `dataDir` sostituiscono quelli
 * dell'ambiente (bootstrap, test). Con CALDES_WATCH=off o senza Radicale
 * configurato resta spento e lo dichiara nello stato. Prima del canary la
 * modalità è `remote` (il mount non è ancora verificato): la passa a `mount`
 * un canary riuscito (startCanarySchedule o runCanary).
 */
export async function startCalendarWatcher(opts: { intervalMs?: number; dataDir?: string; client?: RadicaleClient | null; remotePollMs?: number } = {}): Promise<void> {
  if (w.running) return;
  const overrides: { client?: RadicaleClient | null; dataDir?: string } = {};
  if (opts.client !== undefined) overrides.client = opts.client;
  if (opts.dataDir !== undefined) overrides.dataDir = opts.dataDir;
  if (Object.keys(overrides).length) configureRadicaleRuntime(overrides);
  const rt = radicaleRuntime();
  w.intervalMs = opts.intervalMs ?? INDEX_TIMING.watcherIntervalMs;
  w.remotePollMs = opts.remotePollMs ?? INDEX_TIMING.remotePrincipalPollMs;
  if (!Number.isInteger(w.intervalMs) || w.intervalMs < 10) throw new TypeError(`intervalMs non valido: ${w.intervalMs}`);

  if (rt.watch === 'off') {
    updateWatchMode('off', 'disattivato (CALDES_WATCH=off)');
    log.info('campanello del calendario disattivato (CALDES_WATCH=off)');
    return;
  }
  if (!rt.client) {
    updateWatchMode('off', rt.unavailableReason ?? 'Radicale non configurato');
    log.info({ reason: rt.unavailableReason }, 'campanello del calendario spento: Radicale non configurato');
    return;
  }

  const current = currentWatchMode();
  if (rt.watch === 'remote') setWatchMode('remote', 'CALDES_WATCH=remote');
  else if (current.mode !== 'mount') {
    let mountPresent = false;
    try {
      mountPresent = (await statMtimeNs(rt.dataDir)) !== null;
    } catch {
      mountPresent = false;
    }
    // Senza alert: è lo stato iniziale in attesa del canary, non un guasto.
    updateWatchMode('remote', mountPresent ? 'canary non ancora eseguito' : 'mount assente');
    if (!mountPresent) {
      raiseIndexAlert('watch-remote', `Campanello del calendario in remote mode: mount ${rt.dataDir} assente`, { key: 'mount_missing' });
    }
  }

  w.running = true;
  w.entries.clear();
  w.entriesStale = true;
  w.principalDir = undefined;
  w.principalProps = undefined;
  w.lastRemotePollAt = Number.NEGATIVE_INFINITY;
  w.consecutiveErrors = 0;
  w.unsubscribe.push(
    onSyncSettled((event) => {
      const entry = w.entries.get(event.calendarId);
      if (!entry || !event.result || event.result.status === 'skipped') return;
      entry.synced = event.result.dirMtimeNs === null ? null : BigInt(event.result.dirMtimeNs);
      if (event.result.syncToken) entry.remoteToken = event.result.syncToken;
      // La sync ha azzerato dirty_since fino alla propria stat: se la directory
      // è ancora diversa (modifica arrivata dopo il REPORT) il prossimo giro la
      // segna di nuovo, così un fallimento successivo la porta a unsyncable.
      entry.dirtyMarked = false;
    }),
    onWatchModeChange((state, previous) => {
      if (state.mode === previous.mode) return;
      // Cambio di modalità: si ricontrolla tutto da capo.
      w.lastRemotePollAt = Number.NEGATIVE_INFINITY;
      w.principalProps = undefined;
      w.entriesStale = true;
      for (const entry of w.entries.values()) {
        entry.observed = undefined;
        entry.triggered = undefined;
        entry.remoteToken = undefined;
      }
    }),
  );
  log.info({ mode: currentWatchMode().mode, reason: currentWatchMode().reason, dataDir: rt.dataDir, intervalMs: w.intervalMs }, 'campanello del calendario avviato');
  schedule(0);
}

/** Ferma il campanello e attende il giro e le sync in corso (spegnimento). Idempotente. */
export async function stopCalendarWatcher(): Promise<void> {
  if (!w.running) return;
  w.running = false;
  if (w.timer) clearTimeout(w.timer);
  w.timer = null;
  for (const unsubscribe of w.unsubscribe.splice(0)) unsubscribe();
  await Promise.allSettled([w.ticking, w.discovering].filter(Boolean) as Promise<void>[]);
  await drainSyncs(5_000);
  updateWatchMode('off', 'campanello fermato');
  log.info('campanello del calendario fermato');
}

/** Stato del campanello per la salute (design §16.5). */
export function getWatcherStatus(): WatcherStatus {
  const mode = currentWatchMode();
  const paused = w.running && w.paused !== null;
  return {
    mode: paused ? 'off' : mode.mode,
    running: w.running,
    reason: paused ? w.paused : mode.reason,
    lastTickAt: w.lastTickAt,
    lastChangeAt: w.lastChangeAt,
    consecutiveErrors: w.consecutiveErrors,
    collections: [...w.entries.values()]
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((e) => ({
        calendarId: e.calendarId,
        name: e.name,
        dirMtimeNs: e.observed === undefined || e.observed === null ? null : e.observed.toString(),
        dirtySince: e.dirtySince,
      })),
  };
}

/**
 * true se il campanello gira e ha fatto un giro di recente (per il livello
 * display). Senza `now` l'età dell'ultimo giro è misurata con l'orologio
 * monotono (immune ai salti dell'ora di sistema); con `now` (ms epoch, pagina
 * della salute) dall'ora dell'ultimo giro.
 */
export function watcherAlive(now?: number): boolean {
  if (!w.running || !w.lastTickAt) return false;
  const age = now === undefined ? mono() - w.lastTickMono : now - w.lastTickAt.getTime();
  return age <= Math.max(10_000, w.intervalMs * 10);
}
