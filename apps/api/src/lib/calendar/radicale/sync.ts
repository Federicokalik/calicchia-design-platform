/**
 * Sincronizzazione Radicale → indice (fase F2 del passaggio a Radicale;
 * design §6.1-§6.3 e §6.5, contratto dei moduli
 * docs/calendar-radicale/contracts/f2-modules.md §4.3).
 *
 * syncCollection(c) è l'UNICO canale dati da Radicale verso l'indice: il
 * watcher, la freshness delle prenotazioni, il write-through dello store, il
 * poll della remote mode, l'auditor e il rebuild passano tutti da qui. Passi
 * (design §6.2):
 *  1. identità del volume `ok` (altrimenti stop: CollectionSyncError
 *     'identity', l'indice resta com'è);
 *  2. mtime m0 della directory e istante di osservazione, prima del REPORT;
 *  3. REPORT sync-collection dal token salvato; 403 valid-sync-token (token
 *     scaduto o sconosciuto) → full resync: sync a token vuoto (listing
 *     completo con gli etag) e diff con l'indice;
 *  4. multiget a blocchi di 100 degli href nuovi o con etag cambiato;
 *  5. classificazione dei 404: file ancora su disco → item saltato da
 *     Radicale (skip_broken_item): resta e va in quarantena 'radicale-skip';
 *     file assente → cancellazione candidata; senza un mount affidabile
 *     (remote mode) → pending_404 al primo 404, cancellazione al secondo;
 *  6. interruttore anti-cancellazione di massa: cancellazioni candidate oltre
 *     max(50, 20%) della collezione, collezione svuotata o sparita → hold (le
 *     cancellazioni restano sospese in pending_deletions, le occorrenze
 *     continuano a bloccare, alert); gli upsert si applicano comunque
 *     (contratto §13 precisazione 3);
 *  7. parse ed espansione fuori dalla transazione (prepareCollectionChanges
 *     dell'indicizzatore, worker_threads oltre 200 oggetti);
 *  8. apply nella transazione dell'indicizzatore con CAS sul sync-token
 *     (CollectionCasError → si riparte dal REPORT, al massimo 3 volte);
 *  9. dir_mtime_ns = m0 solo se più vecchia di 50 ms rispetto
 *     all'osservazione (finestra "racy": altrimenti NULL e la prossima
 *     osservazione forza un'altra sync).
 *
 * Concorrenza e connessioni (contratto §1.3):
 *  - single-flight in memoria per collezione: chi arriva prima che la sync in
 *    corso abbia inviato il REPORT si unisce a lei; chi arriva dopo riceve
 *    l'esito di UNA sync successiva condivisa (così l'esito comprende sempre
 *    le modifiche precedenti alla richiesta, come serve al write-through);
 *    una richiesta `full` arrivata durante una sync incrementale ne accoda
 *    una completa. Chi attende non tiene connessioni;
 *  - fra processi: lock cal-sync:<id> dell'indicizzatore
 *    (withCollectionWriteLock) dal REPORT alla COMMIT;
 *  - solo il pool calendario (calSql): la sync non attende MAI il pool
 *    principale, perché la transazione di una prenotazione (pool principale,
 *    lock cal-week) può attendere una sync (freshness). Dentro il lock le
 *    letture usano la connessione riservata del lock.
 *
 * Il modulo contiene anche il "runtime" condiviso dai moduli SYNC (watcher,
 * canary, discovery, freshness): configurazione del client di servizio da
 * ambiente, modalità del campanello (mount/remote/off), percorsi sul mount in
 * sola lettura e verifica dell'identità del volume con cache.
 *
 * Mode postgres: ammessa con identità `ok` (indice popolato in shadow, letto
 * solo da salute e test). Radicale non configurato → 'not_configured'.
 */

import { readdir, readFile, stat, statfs } from 'node:fs/promises';
import { join } from 'node:path';
import type { Logger } from 'pino';
import { calSql } from '../../../db';
import { logger as rootLogger } from '../../logger';
import { readBackendStateFresh } from '../backend-mode';
import { CalendarUnavailableError } from '../errors';
import { INDEX_LIMITS, INDEX_TIMING, targetHorizon } from '../index-model';
import { collectionPath, isValidObjectName, objectPath, type RadicaleClient, radicaleClientFromEnv } from './client';
import { isRadicaleError, type RadicaleError } from './errors';
import { markCollectionDirty, raiseIndexAlert, recordSyncFailure } from './health';
import { requestControlPlaneSync } from './heartbeat';
import { checkVolumeIdentity, type IdentityCheck, type IdentitySource, readVolumeMarkerRemote, resolveIdentitySource } from './identity';
import type * as IndexerModule from './indexer';
import type { ApplyResult, ChangeSetInput, CollectionContext, CollectionLock, RawItem } from './indexer';
import { type Db, RADICALE_DATA_DIR_DEFAULT } from './policy';
import {
  type CalendarBackendState,
  DEFAULT_PRINCIPAL,
  isValidCollectionName,
  isValidPathSegment,
  isValidPrincipal,
  principalPropsPath,
  RADICALE_COLLECTION_ROOT,
} from './types';

const log: Logger = rootLogger.child({ scope: 'calendar-sync' });

// ═══════════════════════════════════════════════════════════════════
// Runtime condiviso dei moduli SYNC
// ═══════════════════════════════════════════════════════════════════

/** Modalità del campanello (design §6.1): stat sul mount, poll remoto, spento. */
export type WatchMode = 'mount' | 'remote' | 'off';

/** CALDES_WATCH: `auto` (mount se c'è, altrimenti remote con RADICALE_URL), `mount`, `remote`, `off`. */
export type WatchSetting = 'auto' | 'mount' | 'remote' | 'off';

/** Sorgente dell'identità (CALDES_IDENTITY_SOURCE, stessa semantica del control-plane). */
export type IdentitySourceSetting = 'auto' | 'file' | 'remote';

export interface RadicaleRuntime {
  /** Client di servizio (caldes-svc); null se Radicale non è configurato. */
  readonly client: RadicaleClient | null;
  /** Principal canonico (RADICALE_PRINCIPAL). */
  readonly principal: string;
  /** Cartella delle collezioni montata in sola lettura (RADICALE_DATA_DIR). */
  readonly dataDir: string;
  readonly watch: WatchSetting;
  readonly identitySource: IdentitySourceSetting;
  /** Perché il client manca (null se c'è). */
  readonly unavailableReason: string | null;
}

let runtime: RadicaleRuntime | null = null;
/** Client creato da questo modulo dalle variabili d'ambiente (da chiudere al reset). */
let ownedClient: RadicaleClient | null = null;

function parseSetting<T extends string>(raw: string | undefined, allowed: readonly T[], fallback: T, name: string): T {
  const value = raw?.trim().toLowerCase();
  if (!value) return fallback;
  if ((allowed as readonly string[]).includes(value)) return value as T;
  log.warn({ value: raw }, `${name} non valida: uso ${fallback}`);
  return fallback;
}

function runtimeFromEnv(env: NodeJS.ProcessEnv): RadicaleRuntime {
  let client: RadicaleClient | null = null;
  let unavailableReason: string | null = null;
  const principal = env.RADICALE_PRINCIPAL?.trim() || DEFAULT_PRINCIPAL;
  if (!isValidPrincipal(principal)) {
    unavailableReason = `RADICALE_PRINCIPAL non valido: ${JSON.stringify(principal)}`;
    log.error(unavailableReason);
  } else {
    try {
      client = radicaleClientFromEnv(env, { userAgent: 'caldes-api-sync' });
      if (!client) unavailableReason = 'Radicale non configurato (RADICALE_URL assente)';
    } catch (err) {
      unavailableReason = `client Radicale non configurabile: ${(err as Error).message}`;
      log.error({ err }, 'client Radicale non configurabile: sync, watcher e discovery spenti');
    }
  }
  ownedClient = client;
  const dataDir = env.RADICALE_DATA_DIR?.trim() || RADICALE_DATA_DIR_DEFAULT;
  return {
    client,
    principal: isValidPrincipal(principal) ? principal : DEFAULT_PRINCIPAL,
    dataDir: dataDir.startsWith('/') ? dataDir : RADICALE_DATA_DIR_DEFAULT,
    watch: parseSetting(env.CALDES_WATCH, ['auto', 'mount', 'remote', 'off'] as const, 'auto', 'CALDES_WATCH'),
    identitySource: parseSetting(env.CALDES_IDENTITY_SOURCE, ['auto', 'file', 'remote'] as const, 'auto', 'CALDES_IDENTITY_SOURCE'),
    unavailableReason,
  };
}

/** Configurazione corrente (letta dall'ambiente al primo uso). Nessun I/O. */
export function radicaleRuntime(): RadicaleRuntime {
  runtime ??= runtimeFromEnv(process.env);
  return runtime;
}

/**
 * Sostituisce parti della configurazione (bootstrap con un client già
 * costruito, test). `null` torna alla configurazione da ambiente, chiudendo il
 * client creato da questo modulo. Svuota la cache dell'identità.
 */
export function configureRadicaleRuntime(overrides: Partial<Omit<RadicaleRuntime, 'unavailableReason'>> | null): RadicaleRuntime {
  identityCache = null;
  localFsCache = null;
  if (overrides === null) {
    ownedClient?.close();
    ownedClient = null;
    runtime = null;
    return radicaleRuntime();
  }
  const base = radicaleRuntime();
  if (overrides.principal !== undefined && !isValidPrincipal(overrides.principal)) {
    throw new TypeError(`principal non valido: ${JSON.stringify(overrides.principal)}`);
  }
  const client = overrides.client === undefined ? base.client : overrides.client;
  runtime = {
    ...base,
    ...overrides,
    client,
    unavailableReason: client ? null : base.unavailableReason ?? 'Radicale non configurato',
  };
  return runtime;
}

// ─── Modalità del campanello ─────────────────────

interface WatchState {
  mode: WatchMode;
  reason: string | null;
  since: Date;
}

let watchState: WatchState = { mode: 'off', reason: 'non avviato', since: new Date() };
const watchListeners = new Set<(state: Readonly<WatchState>, previous: Readonly<WatchState>) => void>();

/** Modalità corrente del campanello (impostata da watcher e canary). */
export function currentWatchMode(): Readonly<WatchState> {
  return watchState;
}

/**
 * Cambia la modalità (watcher.setWatchMode e canary la usano). Restituisce
 * true se è cambiata. Gli ascoltatori non possono interrompere il cambio.
 */
export function updateWatchMode(mode: WatchMode, reason: string | null): boolean {
  if (watchState.mode === mode && watchState.reason === reason) return false;
  const previous = watchState;
  watchState = { mode, reason, since: new Date() };
  for (const listener of watchListeners) {
    try {
      listener(watchState, previous);
    } catch (err) {
      log.error({ err }, 'ascoltatore della modalità del campanello fallito');
    }
  }
  return true;
}

/** Ascolta i cambi di modalità; restituisce la funzione che smette di ascoltare. */
export function onWatchModeChange(listener: (state: Readonly<WatchState>, previous: Readonly<WatchState>) => void): () => void {
  watchListeners.add(listener);
  return () => watchListeners.delete(listener);
}

// ─── Mount in sola lettura ─────────────────────

/** Magic number di statfs dei filesystem locali ammessi (design §6.1). */
export const LOCAL_FS_TYPES: Readonly<Record<string, number>> = Object.freeze({
  ext4: 0xef53,
  xfs: 0x58465342,
  btrfs: 0x9123683e,
});

/** Nomi noti per i messaggi e per CALDES_WATCH_FS_TYPES (solo test). */
const KNOWN_FS_TYPES: Readonly<Record<string, number>> = Object.freeze({
  ...LOCAL_FS_TYPES,
  tmpfs: 0x01021994,
  overlay: 0x794c7630,
  nfs: 0x6969,
  cifs: 0xff534d42,
  smb2: 0xfe534d42,
  fuse: 0x65735546,
  zfs: 0x2fc12fc1,
});

/**
 * Tipi di filesystem accettati da statfs: ext4, xfs e btrfs, oppure
 * l'elenco di CALDES_WATCH_FS_TYPES (solo test: nomi noti o numeri,
 * separati da virgola, es. "tmpfs" o "0x01021994").
 */
export function acceptedFsTypes(env: NodeJS.ProcessEnv = process.env): Set<number> {
  const raw = env.CALDES_WATCH_FS_TYPES?.trim();
  if (!raw) return new Set(Object.values(LOCAL_FS_TYPES));
  const out = new Set<number>();
  for (const part of raw.split(',').map((p) => p.trim().toLowerCase()).filter(Boolean)) {
    const n = KNOWN_FS_TYPES[part] ?? (/^(0x[0-9a-f]+|\d+)$/.test(part) ? Number(part) : NaN);
    if (Number.isFinite(n)) out.add(n);
    else log.warn({ value: part }, 'CALDES_WATCH_FS_TYPES: tipo sconosciuto ignorato');
  }
  return out;
}

/** Descrizione del tipo di filesystem (`ext4 (0xef53)`). */
export function describeFsType(type: number | bigint): string {
  const n = Number(type);
  const name = Object.entries(KNOWN_FS_TYPES).find(([, v]) => v === n)?.[0];
  return `${name ?? 'sconosciuto'} (0x${n.toString(16)})`;
}

let localFsCache: { dir: string; at: number; local: boolean; type: number | null } | null = null;
const LOCAL_FS_CACHE_MS = 60_000;

/**
 * Il mount è su un filesystem locale (statfs), quindi l'esistenza di un file
 * è affidabile anche quando la mtime non è verificata dal canary. Cache di 60 s.
 */
export async function mountIsLocal(dir: string = radicaleRuntime().dataDir): Promise<{ local: boolean; type: number | null }> {
  const now = performance.now();
  if (localFsCache && localFsCache.dir === dir && now - localFsCache.at < LOCAL_FS_CACHE_MS) {
    return { local: localFsCache.local, type: localFsCache.type };
  }
  let local = false;
  let type: number | null = null;
  try {
    const info = await statfs(dir);
    type = Number(info.type);
    local = acceptedFsTypes().has(type);
  } catch {
    local = false;
  }
  localFsCache = { dir, at: now, local, type };
  return { local, type };
}

/** Cartella del principal sul mount: `<dataDir>/collection-root/<principal>`. */
export function principalDirPath(rt: RadicaleRuntime = radicaleRuntime()): string {
  return join(rt.dataDir, RADICALE_COLLECTION_ROOT, rt.principal);
}

/** Cartella di una collezione sul mount (anche `_canary`). */
export function collectionDirPath(collectionName: string, rt: RadicaleRuntime = radicaleRuntime()): string {
  if (!isValidPathSegment(collectionName)) throw new TypeError(`nome di collezione non valido: ${JSON.stringify(collectionName)}`);
  return join(principalDirPath(rt), collectionName);
}

/**
 * mtime in nanosecondi di un percorso; null se non esiste (ENOENT, ENOTDIR).
 * Altri errori (permessi, I/O) si propagano: il chiamante li conta come guasto.
 */
export async function statMtimeNs(path: string): Promise<bigint | null> {
  try {
    return (await stat(path, { bigint: true })).mtimeNs;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return null;
    throw err;
  }
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

/** Dimensione massima di un item letto dal mount (max_resource_size di Radicale, design §3.2). */
const MAX_DISK_ITEM_BYTES = 10_000_000;

/**
 * Item letto dal mount (oggetti saltati da Radicale): `exists` dice se il file
 * c'è; `raw` è il testo (null se illeggibile o troppo grande).
 */
async function readDiskItem(dir: string, name: string): Promise<{ exists: boolean; raw: string | null }> {
  const path = join(dir, name);
  try {
    const info = await stat(path);
    if (!info.isFile()) return { exists: false, raw: null };
    if (info.size > MAX_DISK_ITEM_BYTES) return { exists: true, raw: null };
    return { exists: true, raw: await readFile(path, 'utf8') };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return { exists: false, raw: null };
    return { exists: true, raw: null };
  }
}

/** Nomi degli item sul mount (file che non iniziano con '.', cioè non quelli interni di Radicale). */
async function listDiskItems(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  return entries.filter((e) => e.isFile() && !e.name.startsWith('.') && isValidObjectName(e.name)).map((e) => e.name);
}

// ─── Identità del volume ─────────────────────

export interface VerifiedIdentity {
  state: CalendarBackendState;
  check: IdentityCheck;
}

interface IdentityCacheEntry {
  key: string;
  at: number;
  check: IdentityCheck;
}

let identityCache: IdentityCacheEntry | null = null;
let lastIdentityStatus: string | null = null;
/** Validità della lettura dal file: si rilegge comunque ogni 30 s anche senza cambi di mtime. */
const IDENTITY_FILE_CACHE_MS = 30_000;
/** Validità della lettura remota (PROPFIND del principal). */
const IDENTITY_REMOTE_CACHE_MS = 5_000;
/** Timeout della PROPFIND del marker nelle decisioni. */
const IDENTITY_REMOTE_TIMEOUT_MS = 2_000;

/**
 * Sorgente dell'identità secondo CALDES_IDENTITY_SOURCE (il mount se c'è,
 * altrimenti la PROPFIND). La lettura remota ha un timeout breve: serve anche
 * dentro il budget di 2,5 s delle decisioni.
 */
async function identitySource(rt: RadicaleRuntime): Promise<IdentitySource> {
  const source = await resolveIdentitySource(rt.identitySource, rt.dataDir, rt.client);
  if (source.kind !== 'remote' || !rt.client) return source;
  const client = rt.client;
  return {
    kind: 'remote',
    description: source.description,
    read: (principal) => readVolumeMarkerRemote(client, principal, { timeoutMs: IDENTITY_REMOTE_TIMEOUT_MS }),
  };
}

async function fileKey(path: string): Promise<string> {
  try {
    const info = await stat(path, { bigint: true });
    return `${info.mtimeNs}:${info.size}:${info.ino}`;
  } catch (err) {
    return `missing:${(err as NodeJS.ErrnoException).code ?? '?'}`;
  }
}

/**
 * Identità del volume contro lo stato in PG (contratto control-plane §4.3)
 * per watcher, sync, discovery e freshness. Dal file del principal sul mount:
 * cache finché mtime, dimensione e inode delle props e (volume_id, epoch) non
 * cambiano (al più 30 s); in remote: PROPFIND con cache di 5 s. Lo stato si
 * legge senza cache dal `db` dato (default il pool calendario) se non è
 * passato. A ogni cambio di esito: log, alert e giro immediato del
 * control-plane (policy frozen per mismatch). Lancia solo se lo stato non si
 * legge (CalendarUnavailableError 'state_unreadable').
 */
export async function verifyVolumeIdentity(opts: { db?: Db; state?: CalendarBackendState; force?: boolean } = {}): Promise<VerifiedIdentity> {
  const state = opts.state ?? (await readBackendStateFresh(opts.db ?? calSql));
  const rt = radicaleRuntime();
  const source = await identitySource(rt);
  let key = `${source.kind}|${source.description}|${state.volume_id ?? '-'}|${state.epoch}`;
  let ttl = IDENTITY_REMOTE_CACHE_MS;
  if (source.kind === 'file') {
    key += `|${await fileKey(principalPropsPath(rt.dataDir, rt.principal))}`;
    ttl = IDENTITY_FILE_CACHE_MS;
  }
  const now = performance.now();
  if (!opts.force && identityCache && identityCache.key === key && now - identityCache.at < ttl) {
    return { state, check: identityCache.check };
  }
  const check = await checkVolumeIdentity(state, source, rt.principal);
  identityCache = { key, at: now, check };
  noteIdentity(check);
  return { state, check };
}

/** Ultimo controllo d'identità fatto dai moduli SYNC (null se mai). */
export function lastIdentityCheck(): IdentityCheck | null {
  return identityCache?.check ?? null;
}

/** Svuota la cache dell'identità (dopo una transizione d'epoch del processo, nei test). */
export function invalidateIdentityCache(): void {
  identityCache = null;
}

function noteIdentity(check: IdentityCheck): void {
  const key = `${check.status}|${check.detail ?? ''}`;
  if (key === lastIdentityStatus) return;
  const first = lastIdentityStatus === null;
  const previous = lastIdentityStatus?.split('|')[0] ?? null;
  lastIdentityStatus = key;
  const fields = { status: check.status, source: check.source, detail: check.detail, marker: check.marker };
  if (check.status === 'mismatch' || check.status === 'unverified') {
    raiseIndexAlert('volume-identity', `Identità del volume di Radicale ${check.status}: sync, discovery e decisioni sospese`, {
      key: check.status,
      status: check.status,
      detail: check.detail ?? undefined,
    });
  } else if (!first || check.status === 'ok') {
    log.info(fields, 'identità del volume di Radicale');
  }
  // La policy dipende dall'identità: il control-plane la riscrive subito
  // invece di attendere il giro di 30 s (no-op se il control-plane è spento).
  if (!first && previous !== check.status) {
    void requestControlPlaneSync().catch((err: unknown) => log.warn({ err }, 'giro del control-plane non riuscito'));
  }
}

// ═══════════════════════════════════════════════════════════════════
// Porta verso l'indicizzatore (INDEX)
// ═══════════════════════════════════════════════════════════════════

/**
 * Funzioni dell'indicizzatore usate dalla sync (contratto §5.1, §5.2). Il
 * modulo si carica alla prima sync (import dinamico): niente cicli di import
 * alla valutazione (indexer → ids, rebuild → sync → indexer) e, nei test, un
 * doppio sostituibile con setSyncIndexPort() per i guasti difficili da
 * provocare.
 */
export interface SyncIndexPort {
  loadCollectionContext: typeof IndexerModule.loadCollectionContext;
  prepareCollectionChanges: typeof IndexerModule.prepareCollectionChanges;
  applyPreparedChanges: typeof IndexerModule.applyPreparedChanges;
  withCollectionWriteLock: typeof IndexerModule.withCollectionWriteLock;
  isCasError(err: unknown): boolean;
  isLockTimeout(err: unknown): boolean;
  /** Calendario cancellato nel frattempo (facoltativo nei doppi di test). */
  isNotFound?(err: unknown): boolean;
  /** Operazione dell'indice interrotta da un AbortSignal (facoltativo nei doppi di test). */
  isAborted?(err: unknown): boolean;
}

let portOverride: SyncIndexPort | null = null;
let portPromise: Promise<SyncIndexPort> | null = null;

async function indexPort(): Promise<SyncIndexPort> {
  if (portOverride) return portOverride;
  portPromise ??= import('./indexer').then((m) => ({
    loadCollectionContext: m.loadCollectionContext,
    prepareCollectionChanges: m.prepareCollectionChanges,
    applyPreparedChanges: m.applyPreparedChanges,
    withCollectionWriteLock: m.withCollectionWriteLock,
    isCasError: (err: unknown) => err instanceof m.CollectionCasError,
    isLockTimeout: (err: unknown) => err instanceof m.CollectionLockTimeoutError,
    isNotFound: (err: unknown) => err instanceof m.CollectionNotFoundError,
    isAborted: (err: unknown) => err instanceof m.IndexAbortedError,
  }));
  try {
    return await portPromise;
  } catch (err) {
    portPromise = null;
    throw err;
  }
}

/** Solo test: sostituisce (o ripristina con null) la porta verso l'indicizzatore. */
export function setSyncIndexPort(port: SyncIndexPort | null): void {
  if (port && process.env.NODE_ENV === 'production') throw new Error('setSyncIndexPort: vietato in produzione');
  portOverride = port;
}

// ═══════════════════════════════════════════════════════════════════
// syncCollection
// ═══════════════════════════════════════════════════════════════════

export type SyncReason = 'watcher' | 'freshness' | 'write-through' | 'remote-poll' | 'auditor' | 'rebuild' | 'manual' | 'startup';

export interface SyncCollectionOptions {
  reason: SyncReason;
  /** Scarica tutta la collezione (rebuild, auditor); con reason 'rebuild' sostituisce atomicamente l'indice della collezione. */
  full?: boolean;
  /** Chi ha provocato la sync (write-through: l'attore della scrittura). */
  actor?: string;
  /** Scadenza (ms epoch): oltre, chi attende riceve 'timeout'. */
  deadline?: number;
  signal?: AbortSignal;
  idStrategy?: 'random' | 'deterministic';
}

export interface SyncCollectionResult {
  calendarId: string;
  status: 'synced' | 'unchanged' | 'held' | 'skipped';
  /** Listing completo (token assente o scaduto, oppure `full` richiesto). */
  full: boolean;
  indexVersion: string;
  syncToken: string | null;
  /** dir_mtime_ns salvata (null: racy, remote mode o collezione sparita). */
  dirMtimeNs: string | null;
  upserted: number;
  deleted: number;
  quarantined: number;
  radicaleSkipped: number;
  pending404: number;
  durationMs: number;
}

/**
 * 'radicale' copre ogni guasto del canale dati (Radicale, ma anche database e
 * indicizzatore durante la sync); 'timeout' la scadenza del chiamante o di una
 * richiesta; 'collection_missing' un calendario senza riga nel sidecar.
 */
export type CollectionSyncErrorCode = 'identity' | 'not_configured' | 'radicale' | 'cas_exhausted' | 'lock_timeout' | 'timeout' | 'collection_missing' | 'aborted';

export class CollectionSyncError extends Error {
  readonly calendarId: string;
  readonly code: CollectionSyncErrorCode;
  constructor(calendarId: string, code: CollectionSyncErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'CollectionSyncError';
    this.calendarId = calendarId;
    this.code = code;
  }
}

/** Motivi della sospensione delle cancellazioni (cal_collection_state.hold_reason). */
export const HOLD_REASONS = Object.freeze({
  /** Cancellazioni candidate oltre max(50, 20%) della collezione. */
  massDelete: 'mass-delete',
  /** Tutti gli oggetti della collezione (almeno 2) spariti. */
  collectionEmpty: 'collection-empty',
  /** La collezione intera non esiste più su Radicale (404 sul REPORT). */
  collectionMissing: 'collection-missing',
});

/** Tentativi della sync quando il CAS sul token fallisce (design §6.2 passo 8). */
const MAX_CAS_ATTEMPTS = 3;
/** Collezione svuotata: l'interruttore scatta da 2 oggetti in su (cancellare l'unico evento di un calendario non è una cancellazione di massa). */
const EMPTY_COLLECTION_MIN_OBJECTS = 2;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface SyncRun {
  readonly calendarId: string;
  opts: SyncCollectionOptions;
  full: boolean;
  /** Il REPORT è partito: da qui chi arriva attende la sync successiva. */
  reportStarted: boolean;
  readonly promise: Promise<SyncCollectionResult>;
  start(): void;
}

interface Flight {
  running: SyncRun | null;
  queued: SyncRun | null;
}

const flights = new Map<string, Flight>();
/** Interrompe le sync in corso allo spegnimento (drainSyncs). */
let shutdown = new AbortController();

export interface SyncSettledEvent {
  calendarId: string;
  reason: SyncReason;
  result: SyncCollectionResult | null;
  error: CollectionSyncError | null;
}

const settledListeners = new Set<(event: SyncSettledEvent) => void>();

/** Ascolta l'esito di ogni sync (il watcher aggiorna così la propria dir_mtime_ns nota). */
export function onSyncSettled(listener: (event: SyncSettledEvent) => void): () => void {
  settledListeners.add(listener);
  return () => settledListeners.delete(listener);
}

function emitSettled(event: SyncSettledEvent): void {
  for (const listener of settledListeners) {
    try {
      listener(event);
    } catch (err) {
      log.error({ err }, 'ascoltatore dell\'esito della sync fallito');
    }
  }
}

function createRun(calendarId: string, opts: SyncCollectionOptions, flight: Flight): SyncRun {
  let resolve!: (r: SyncCollectionResult) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<SyncCollectionResult>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  // Nessun "unhandled rejection" se nessuno attende (chi attende riceve comunque l'errore).
  promise.catch(() => undefined);
  const run: SyncRun = {
    calendarId,
    opts: { ...opts },
    full: !!opts.full,
    reportStarted: false,
    promise,
    start: () => {
      // Il volo si chiude (o passa alla sync accodata) PRIMA di consegnare
      // l'esito: chi lo riceve e richiama syncCollection ne avvia una nuova.
      const settle = (event: SyncSettledEvent, deliver: () => void): void => {
        flight.running = null;
        const next = flight.queued;
        flight.queued = null;
        if (next) {
          flight.running = next;
          next.start();
        } else {
          flights.delete(calendarId);
        }
        emitSettled(event);
        deliver();
      };
      void runSync(run).then(
        (result) => settle({ calendarId, reason: run.opts.reason, result, error: null }, () => resolve(result)),
        (error: CollectionSyncError) => settle({ calendarId, reason: run.opts.reason, result: null, error }, () => reject(error)),
      );
    },
  };
  return run;
}

/** Unisce le opzioni di una richiesta a quelle della sync accodata. */
function mergeQueued(run: SyncRun, opts: SyncCollectionOptions): void {
  if (opts.full) run.full = true;
  if (run.opts.deadline !== undefined) {
    run.opts.deadline = opts.deadline === undefined ? undefined : Math.max(run.opts.deadline, opts.deadline);
  }
  if (opts.idStrategy === 'deterministic') run.opts.idStrategy = 'deterministic';
  if (opts.reason === 'rebuild') run.opts.reason = 'rebuild';
}

/** Attende l'esito della sync entro la scadenza e il signal del chiamante (la sync prosegue comunque). */
function awaitRun(run: SyncRun, opts: SyncCollectionOptions): Promise<SyncCollectionResult> {
  const { deadline, signal } = opts;
  if (deadline === undefined && !signal) return run.promise;
  return new Promise<SyncCollectionResult>((resolve, reject) => {
    let timer: NodeJS.Timeout | null = null;
    const done = (): void => {
      if (timer) clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    };
    const onAbort = (): void => {
      done();
      reject(new CollectionSyncError(run.calendarId, 'aborted', 'attesa della sync interrotta'));
    };
    if (signal?.aborted) return onAbort();
    signal?.addEventListener('abort', onAbort, { once: true });
    if (deadline !== undefined) {
      const ms = deadline - Date.now();
      if (ms <= 0) {
        done();
        return reject(new CollectionSyncError(run.calendarId, 'timeout', 'scadenza superata prima della sync'));
      }
      timer = setTimeout(() => {
        done();
        reject(new CollectionSyncError(run.calendarId, 'timeout', `sync non conclusa entro la scadenza (${run.opts.reason})`));
      }, ms);
      timer.unref?.();
    }
    run.promise.then(
      (r) => {
        done();
        resolve(r);
      },
      (e) => {
        done();
        reject(e);
      },
    );
  });
}

/**
 * Sincronizza una collezione Radicale-backed nell'indice (design §6.2).
 * Single-flight per collezione (vedi testa del file). Lancia
 * CollectionSyncError; i guasti del canale dati sono già registrati nella
 * salute della collezione (recordSyncFailure). Il ruolo `subscription` (fonte
 * remota) e i calendari non attivi restituiscono `skipped`.
 */
export function syncCollection(calendarId: string, opts: SyncCollectionOptions): Promise<SyncCollectionResult> {
  if (typeof calendarId !== 'string' || !UUID_RE.test(calendarId)) {
    return Promise.reject(new CollectionSyncError(String(calendarId), 'collection_missing', 'id di calendario non valido'));
  }
  const id = calendarId.toLowerCase();
  let flight = flights.get(id);
  if (!flight) {
    flight = { running: null, queued: null };
    flights.set(id, flight);
  }
  let run: SyncRun;
  const current = flight.running;
  if (!current) {
    run = createRun(id, opts, flight);
    flight.running = run;
    run.start();
  } else if (!current.reportStarted && (current.full || !opts.full)) {
    run = current;
  } else if (flight.queued) {
    run = flight.queued;
    mergeQueued(run, opts);
  } else {
    run = createRun(id, opts, flight);
    flight.queued = run;
  }
  return awaitRun(run, opts);
}

/** Collezioni con una sync in corso (o accodata). */
export function inFlightSyncs(): string[] {
  return [...flights.keys()];
}

/**
 * Attende la fine delle sync in corso e accodate (spegnimento), al massimo
 * `timeoutMs`; poi interrompe quelle ancora attive.
 */
export async function drainSyncs(timeoutMs = 5_000): Promise<void> {
  const pending = [...flights.values()].flatMap((f) => [f.running?.promise, f.queued?.promise]).filter(Boolean) as Promise<unknown>[];
  if (!pending.length) return;
  const timer = new Promise<void>((r) => setTimeout(r, timeoutMs).unref?.());
  await Promise.race([Promise.allSettled(pending), timer]);
  shutdown.abort();
  await Promise.allSettled(pending);
  shutdown = new AbortController();
}

// ─── Esecuzione ─────────────────────

interface CollectionMeta {
  id: string;
  collection_name: string | null;
  role: string;
  lifecycle: string;
}

interface StateRow {
  sync_token: string | null;
  dir_mtime_ns: string | null;
  health: string;
  hold_reason: string | null;
  pending_deletions: string[];
  horizon_start: Date | null;
  horizon_end: Date | null;
}

interface IndexedRow {
  href: string;
  etag: string | null;
  health: string;
  pending_404_count: number;
}

function emptyResult(calendarId: string, startedAt: number, status: SyncCollectionResult['status']): SyncCollectionResult {
  return {
    calendarId,
    status,
    full: false,
    indexVersion: '0',
    syncToken: null,
    dirMtimeNs: null,
    upserted: 0,
    deleted: 0,
    quarantined: 0,
    radicaleSkipped: 0,
    pending404: 0,
    durationMs: Math.round(performance.now() - startedAt),
  };
}

function nameOf(href: string): string | null {
  const last = href.replace(/\/+$/, '').split('/').pop() ?? '';
  let name: string;
  try {
    name = decodeURIComponent(last);
  } catch {
    return null;
  }
  return isValidObjectName(name) ? name : null;
}

/** Timeout della prossima richiesta a Radicale secondo la scadenza (o quello del client). */
function requestTimeout(deadline: number | undefined, calendarId: string): number | undefined {
  if (deadline === undefined) return undefined;
  const ms = deadline - Date.now();
  if (ms <= 0) throw new CollectionSyncError(calendarId, 'timeout', 'scadenza della sync superata');
  return Math.max(50, ms);
}

function throwIfAborted(signal: AbortSignal, calendarId: string): void {
  if (signal.aborted) throw new CollectionSyncError(calendarId, 'aborted', 'sync interrotta (spegnimento)');
}

/** Converte un errore qualsiasi della sync nel codice del contratto. */
function toSyncError(calendarId: string, err: unknown, port: SyncIndexPort | null): CollectionSyncError {
  if (err instanceof CollectionSyncError) return err;
  if (port?.isLockTimeout(err)) {
    return new CollectionSyncError(calendarId, 'lock_timeout', 'lock della collezione non ottenuto entro la scadenza', { cause: err });
  }
  if (port?.isNotFound?.(err)) {
    return new CollectionSyncError(calendarId, 'collection_missing', 'calendario cancellato durante la sync', { cause: err });
  }
  if (port?.isAborted?.(err)) {
    return new CollectionSyncError(calendarId, 'aborted', 'sync interrotta', { cause: err });
  }
  if (isRadicaleError(err)) {
    const e = err as RadicaleError;
    return new CollectionSyncError(calendarId, e.code === 'timeout' ? 'timeout' : 'radicale', `Radicale: ${e.message}`, { cause: err });
  }
  if (err instanceof CalendarUnavailableError) {
    return new CollectionSyncError(calendarId, 'identity', `stato del backend non leggibile: ${err.message}`, { cause: err });
  }
  if ((err as Error)?.name === 'AbortError') {
    return new CollectionSyncError(calendarId, 'aborted', 'sync interrotta', { cause: err });
  }
  return new CollectionSyncError(calendarId, 'radicale', `errore della sync: ${(err as Error)?.message ?? String(err)}`, { cause: err });
}

async function runSync(run: SyncRun): Promise<SyncCollectionResult> {
  const startedAt = performance.now();
  const id = run.calendarId;
  const signal = shutdown.signal;
  let port: SyncIndexPort | null = null;
  try {
    const rt = radicaleRuntime();
    if (!rt.client) throw new CollectionSyncError(id, 'not_configured', rt.unavailableReason ?? 'Radicale non configurato');
    throwIfAborted(signal, id);
    requestTimeout(run.opts.deadline, id);

    const [meta]: CollectionMeta[] = await calSql`
      SELECT id, collection_name, role, lifecycle FROM calendars WHERE id = ${id}
    `;
    if (!meta) throw new CollectionSyncError(id, 'collection_missing', 'calendario inesistente nel sidecar');
    if (meta.role === 'subscription' || meta.lifecycle !== 'active' || !isValidCollectionName(meta.collection_name)) {
      return emptyResult(id, startedAt, 'skipped');
    }

    const identity = await verifyVolumeIdentity({ db: calSql });
    if (identity.check.status !== 'ok') {
      throw new CollectionSyncError(id, 'identity', `identità del volume ${identity.check.status}${identity.check.detail ? ` (${identity.check.detail})` : ''}`);
    }

    port = await indexPort();
    const context = await port.loadCollectionContext(calSql, id);
    for (let attempt = 1; ; attempt++) {
      try {
        return await port.withCollectionWriteLock(
          id,
          (lock) => syncUnderLock({ run, lock, port: port as SyncIndexPort, context, meta, rt, startedAt, signal }),
          { deadline: run.opts.deadline, signal },
        );
      } catch (err) {
        if (port.isCasError(err)) {
          if (attempt < MAX_CAS_ATTEMPTS) {
            log.info({ calendarId: id, attempt }, 'sync-token cambiato durante la sync: si riparte dal REPORT');
            run.reportStarted = false;
            continue;
          }
          throw new CollectionSyncError(id, 'cas_exhausted', `sync-token cambiato a ogni tentativo (${MAX_CAS_ATTEMPTS})`, { cause: err });
        }
        throw err;
      }
    }
  } catch (err) {
    const error = toSyncError(id, err, port);
    // Guasti del canale dati: la salute della collezione li registra
    // (unsyncable con modifiche pendenti). Non lo sono l'identità (globale),
    // la configurazione, un lock occupato da un altro scrittore, la scadenza
    // del chiamante e lo spegnimento.
    const callerDeadline = error.code === 'timeout' && run.opts.deadline !== undefined;
    if ((error.code === 'radicale' || error.code === 'timeout' || error.code === 'cas_exhausted') && !callerDeadline) {
      try {
        await recordSyncFailure(calSql, id, err, new Date());
      } catch (recordErr) {
        log.error({ err: recordErr, calendarId: id }, 'fallimento della sync non registrato');
      }
    }
    if (error.code !== 'identity' && error.code !== 'not_configured') {
      log.warn({ calendarId: id, code: error.code, reason: run.opts.reason, err: error.message }, 'sync della collezione non riuscita');
    }
    throw error;
  }
}

interface UnderLockArgs {
  run: SyncRun;
  lock: CollectionLock;
  port: SyncIndexPort;
  context: CollectionContext;
  meta: CollectionMeta;
  rt: RadicaleRuntime;
  startedAt: number;
  signal: AbortSignal;
}

async function syncUnderLock(args: UnderLockArgs): Promise<SyncCollectionResult> {
  const { run, lock, port, context, meta, rt, startedAt, signal } = args;
  const id = run.calendarId;
  const client = rt.client as RadicaleClient;
  const collection = meta.collection_name as string;
  const deadline = run.opts.deadline;
  const conn = lock.conn;

  const [state]: StateRow[] = await conn`
    SELECT sync_token, dir_mtime_ns::text AS dir_mtime_ns, health, hold_reason, pending_deletions, horizon_start, horizon_end
    FROM cal_collection_state WHERE calendar_id = ${id}
  `;
  const index: IndexedRow[] = await conn`
    SELECT href, etag, health, pending_404_count FROM cal_objects WHERE calendar_id = ${id}
  `;
  const indexed = new Map(index.map((r) => [r.href, r]));
  const horizon = state?.horizon_start && state.horizon_end
    ? { start: state.horizon_start, end: state.horizon_end }
    : targetHorizon(new Date());
  const actor = run.opts.reason === 'write-through' ? `write-through:${run.opts.actor ?? 'api'}` : run.opts.reason === 'rebuild' ? 'rebuild' : 'sync';

  // 2. m0 e istante di osservazione, prima del REPORT (solo con il mount affidabile).
  const mount = currentWatchMode().mode === 'mount';
  const dir = collectionDirPath(collection, rt);
  let m0: bigint | null = null;
  let observedMs = 0;
  if (mount) {
    m0 = await statMtimeNs(dir);
    observedMs = Date.now();
  }

  // 3. REPORT sync-collection; token scaduto → listing completo.
  const startToken = state?.sync_token ?? null;
  const fetchAll = run.full;
  let full = fetchAll || startToken === null;
  const path = collectionPath(rt.principal, collection);
  run.reportStarted = true;
  throwIfAborted(signal, id);
  let report: Awaited<ReturnType<RadicaleClient['syncCollection']>>;
  try {
    report = await client.syncCollection(path, { syncToken: full ? '' : startToken, timeoutMs: requestTimeout(deadline, id) });
  } catch (err) {
    if (!full && isRadicaleError(err, 'invalid_sync_token')) {
      log.info({ calendarId: id, collection }, 'sync-token scaduto o sconosciuto: full resync');
      full = true;
      report = await client.syncCollection(path, { syncToken: '', timeoutMs: requestTimeout(deadline, id) });
    } else if (isRadicaleError(err, 'not_found')) {
      return holdMissingCollection({ ...args, state, index, horizon, actor, startToken });
    } else {
      throw err;
    }
  }

  const listing = new Map<string, string | null>();
  for (const change of report.changed) {
    const name = nameOf(change.href);
    if (name) listing.set(name, change.etag);
  }
  const removed = new Set(report.removed.map(nameOf).filter((n): n is string => n !== null));

  // 4. Da scaricare: nuovi, etag cambiato, oggetti non sani (o tutto, se richiesto).
  const toFetch = new Set<string>();
  for (const [name, etag] of listing) {
    const row = indexed.get(name);
    if (fetchAll || !row || row.etag !== etag || row.health !== 'ok') toFetch.add(name);
  }
  const diskUsable = mount || ((await isDirectory(dir)) && (await mountIsLocal(rt.dataDir)).local);
  // Senza un mount affidabile i pending_404 si riverificano a ogni sync: il
  // token non li ripresenta, e il secondo 404 consecutivo li cancella.
  if (!mount) for (const row of index) if (row.health === 'pending_404' && !listing.has(row.href)) toFetch.add(row.href);

  const candidates404 = new Set<string>();
  if (full) for (const row of index) if (!listing.has(row.href)) candidates404.add(row.href);
  for (const name of removed) if (!listing.has(name)) candidates404.add(name);
  // Item rotti che il listing completo non riporta (skip_broken_item: né fra
  // gli oggetti né fra i 404): file su disco assenti dal listing.
  if (full && diskUsable) {
    for (const name of await listDiskItems(dir)) if (!listing.has(name)) candidates404.add(name);
  }

  const upserts: RawItem[] = [];
  const fetched = new Set<string>();
  const batch: string[] = [];
  const flush = async (): Promise<void> => {
    if (!batch.length) return;
    throwIfAborted(signal, id);
    const res = await client.calendarMultiget(path, batch.map((n) => objectPath(rt.principal, collection, n)), { timeoutMs: requestTimeout(deadline, id) });
    for (const obj of res.objects) {
      const name = nameOf(obj.href);
      if (!name || fetched.has(name)) continue;
      fetched.add(name);
      upserts.push({ href: name, etag: obj.etag, raw: obj.data });
    }
    for (const href of res.missing) {
      const name = nameOf(href);
      if (name) candidates404.add(name);
    }
    batch.length = 0;
  };
  for (const name of toFetch) {
    batch.push(name);
    if (batch.length >= INDEX_LIMITS.multigetBatch) await flush();
  }
  await flush();

  // 5. Classificazione dei 404.
  const radicaleSkipped: RawItem[] = [];
  const pending404: string[] = [];
  const deletions: string[] = [];
  for (const name of candidates404) {
    if (fetched.has(name)) continue; // ricomparso fra REPORT e multiget
    const row = indexed.get(name);
    if (diskUsable) {
      const disk = await readDiskItem(dir, name);
      if (disk.exists) {
        radicaleSkipped.push({ href: name, etag: row?.etag ?? null, raw: disk.raw });
        continue;
      }
      if (mount) {
        if (row) deletions.push(name);
        continue;
      }
    }
    if (!row) continue; // tombstone di un oggetto mai indicizzato
    if (row.health === 'pending_404' || row.pending_404_count > 0) deletions.push(name);
    else pending404.push(name);
  }
  if (radicaleSkipped.length) {
    log.warn({ calendarId: id, collection, hrefs: radicaleSkipped.map((r) => r.href) }, 'item saltati da Radicale (file presente su disco): quarantena radicale-skip');
  }

  // 6. Interruttore anti-cancellazione di massa.
  const present = new Set([...listing.keys(), ...fetched, ...radicaleSkipped.map((r) => r.href)]);
  const hold = massDeleteBreaker({ calendarId: id, collection, state, total: index.length, deletions, present });
  const deletes = hold ? [] : deletions;
  // replaceAll (rebuild): ogni risorsa si riscrive; le cancellazioni restano
  // esplicite in `deletes`, quindi passano comunque dall'interruttore.
  const replaceAll = run.opts.reason === 'rebuild' && fetchAll && !hold && pending404.length === 0;
  // Il change set copre tutta la collezione se ogni item del listing completo
  // è stato scaricato (download esplicito, oppure indice vuoto alla prima sync).
  const coversAll = full && [...listing.keys()].every((name) => fetched.has(name) || candidates404.has(name));

  // 7-8. Prepare fuori dalla transazione, poi apply con CAS sul token.
  const input: ChangeSetInput = {
    context,
    upserts,
    deletes,
    radicaleSkipped,
    pending404,
    full: coversAll,
    horizon,
    actor,
    idStrategy: run.opts.idStrategy,
  };
  requestTimeout(deadline, id);
  throwIfAborted(signal, id);
  const prepared = await port.prepareCollectionChanges(input, { worker: 'auto' });
  // 9. dir_mtime_ns solo fuori dalla finestra racy.
  let dirMtimeNs: bigint | null = null;
  if (mount && m0 !== null && observedMs - Number(m0 / 1_000_000n) >= INDEX_TIMING.racyWindowMs) dirMtimeNs = m0;
  throwIfAborted(signal, id);
  const applied = await port.applyPreparedChanges(lock, prepared, {
    expectedSyncToken: startToken,
    newSyncToken: report.syncToken,
    dirMtimeNs,
    hold,
    replaceAll,
    syncedAt: new Date(),
  });
  return buildResult({ id, startedAt, applied, full, syncToken: report.syncToken, dirMtimeNs, hold: !!hold, radicaleSkipped: radicaleSkipped.length, pending404: pending404.length });
}

/**
 * Interruttore anti-cancellazione (design §6.2 passo 6): restituisce la
 * sospensione da passare all'apply, oppure null se le cancellazioni si
 * applicano. Una collezione già in hold accumula le nuove cancellazioni
 * finché l'admin non sceglie; le sospese che ricompaiono escono dall'elenco,
 * e quando non ne resta nessuna la sospensione si toglie da sola.
 */
function massDeleteBreaker(input: {
  calendarId: string;
  collection: string;
  state: StateRow | undefined;
  total: number;
  deletions: string[];
  present: ReadonlySet<string>;
}): { reason: string; pendingDeletions: string[] } | null {
  const { state, total, deletions, present } = input;
  const alreadyHold = state?.health === 'hold';
  const previous = (state?.pending_deletions ?? []).filter((h) => !present.has(h));
  const threshold = Math.max(INDEX_LIMITS.massDeleteMinObjects, total * INDEX_LIMITS.massDeleteRatio);
  const mass = deletions.length > threshold;
  const emptied = total >= EMPTY_COLLECTION_MIN_OBJECTS && deletions.length >= total;
  if (!alreadyHold && !mass && !emptied) return null;
  const pending = [...new Set([...previous, ...deletions])].sort();
  if (alreadyHold) {
    if (!pending.length) {
      log.info({ calendarId: input.calendarId, collection: input.collection }, 'cancellazioni sospese tutte rientrate: sospensione tolta');
      return null;
    }
    return { reason: state?.hold_reason ?? HOLD_REASONS.massDelete, pendingDeletions: pending };
  }
  const reason = emptied ? HOLD_REASONS.collectionEmpty : HOLD_REASONS.massDelete;
  // L'alert 'collection-hold' lo emette l'indicizzatore alla COMMIT della sospensione.
  log.warn(
    { calendarId: input.calendarId, collection: input.collection, reason, deletions: deletions.length, total },
    'interruttore anti-cancellazione: cancellazioni sospese, le occorrenze esistenti continuano a bloccare',
  );
  return { reason, pendingDeletions: pending };
}

/** Collezione sparita da Radicale (404 sul REPORT): nessuna cancellazione, hold con tutti gli oggetti sospesi. */
async function holdMissingCollection(
  args: UnderLockArgs & {
    state: StateRow | undefined;
    index: IndexedRow[];
    horizon: { start: Date; end: Date };
    actor: string;
    startToken: string | null;
  },
): Promise<SyncCollectionResult> {
  const { run, lock, port, context, meta, startedAt, state, index, horizon, actor, startToken } = args;
  const id = run.calendarId;
  const pending = [...new Set([...(state?.pending_deletions ?? []), ...index.map((r) => r.href)])].sort();
  if (state?.health !== 'hold') {
    // L'alert 'collection-hold' lo emette l'indicizzatore alla COMMIT della sospensione.
    log.warn({ calendarId: id, collection: meta.collection_name, objects: index.length }, 'collezione sparita da Radicale: indice invariato, nessuna cancellazione applicata');
  }
  const prepared = await port.prepareCollectionChanges(
    { context, upserts: [], deletes: [], radicaleSkipped: [], pending404: [], full: false, horizon, actor },
    { worker: false },
  );
  const applied = await port.applyPreparedChanges(lock, prepared, {
    expectedSyncToken: startToken,
    newSyncToken: startToken,
    dirMtimeNs: null,
    hold: { reason: HOLD_REASONS.collectionMissing, pendingDeletions: pending },
    syncedAt: new Date(),
  });
  return buildResult({ id, startedAt, applied, full: false, syncToken: startToken, dirMtimeNs: null, hold: true, radicaleSkipped: 0, pending404: 0 });
}

function buildResult(input: {
  id: string;
  startedAt: number;
  applied: ApplyResult;
  full: boolean;
  syncToken: string | null;
  dirMtimeNs: bigint | null;
  hold: boolean;
  radicaleSkipped: number;
  pending404: number;
}): SyncCollectionResult {
  const { applied } = input;
  const changed = applied.upserted + applied.deleted + applied.quarantined + input.radicaleSkipped + input.pending404 > 0;
  return {
    calendarId: input.id,
    status: input.hold || applied.held ? 'held' : changed ? 'synced' : 'unchanged',
    full: input.full,
    indexVersion: String(applied.indexVersion),
    syncToken: input.syncToken,
    dirMtimeNs: input.dirMtimeNs === null ? null : input.dirMtimeNs.toString(),
    upserted: applied.upserted,
    deleted: applied.deleted,
    quarantined: applied.quarantined,
    radicaleSkipped: input.radicaleSkipped,
    pending404: input.pending404,
    durationMs: Math.round(performance.now() - input.startedAt),
  };
}

// ─── Tutte le collezioni ─────────────────────

/** Collezioni Radicale-backed del sidecar (attive, nome valido, mai iscrizioni né `_*`). */
export async function radicaleCollections(db: Db = calSql): Promise<Array<{ id: string; collectionName: string }>> {
  const rows: Array<{ id: string; collection_name: string | null }> = await db`
    SELECT id, collection_name FROM calendars
    WHERE role <> 'subscription' AND lifecycle = 'active' AND collection_name IS NOT NULL
    ORDER BY sort_order, collection_name
  `;
  return rows
    .filter((r) => isValidCollectionName(r.collection_name))
    .map((r) => ({ id: String(r.id).toLowerCase(), collectionName: r.collection_name as string }));
}

/** Concorrenza di syncAllCollections (l'indicizzatore ha comunque il proprio semaforo). */
const SYNC_ALL_CONCURRENCY = 2;

/** Sincronizza tutte le collezioni Radicale-backed; gli errori tornano nell'elenco, non vengono lanciati. */
export async function syncAllCollections(
  opts: Omit<SyncCollectionOptions, 'full'> & { full?: boolean },
): Promise<Array<SyncCollectionResult | CollectionSyncError>> {
  const collections = await radicaleCollections();
  const results: Array<SyncCollectionResult | CollectionSyncError> = new Array(collections.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < collections.length) {
      const i = next++;
      try {
        results[i] = await syncCollection(collections[i].id, opts);
      } catch (err) {
        results[i] = err instanceof CollectionSyncError ? err : toSyncError(collections[i].id, err, null);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(SYNC_ALL_CONCURRENCY, collections.length) }, worker));
  return results;
}

// ─── Cancellazioni sospese ─────────────────────

/**
 * "Applica cancellazioni" dell'admin (design §6.2 passo 6, §16.3): applica le
 * cancellazioni sospese dall'interruttore (tutte o solo `hrefs`). Ogni href si
 * riverifica su Radicale prima: un oggetto ricomparso torna nell'indice
 * invece di essere cancellato, un file ancora su disco va in quarantena. Le
 * sospese non scelte restano in hold. Lancia CollectionSyncError.
 */
export async function applyHeldDeletions(calendarId: string, opts: { actor: string; hrefs?: string[] }): Promise<SyncCollectionResult> {
  const startedAt = performance.now();
  const id = String(calendarId).toLowerCase();
  if (!UUID_RE.test(id)) throw new CollectionSyncError(id, 'collection_missing', 'id di calendario non valido');
  let port: SyncIndexPort | null = null;
  try {
    const rt = radicaleRuntime();
    if (!rt.client) throw new CollectionSyncError(id, 'not_configured', rt.unavailableReason ?? 'Radicale non configurato');
    const [meta]: CollectionMeta[] = await calSql`SELECT id, collection_name, role, lifecycle FROM calendars WHERE id = ${id}`;
    if (!meta) throw new CollectionSyncError(id, 'collection_missing', 'calendario inesistente nel sidecar');
    if (meta.role === 'subscription' || !isValidCollectionName(meta.collection_name)) return emptyResult(id, startedAt, 'skipped');
    const identity = await verifyVolumeIdentity({ db: calSql });
    if (identity.check.status !== 'ok') throw new CollectionSyncError(id, 'identity', `identità del volume ${identity.check.status}`);
    port = await indexPort();
    const context = await port.loadCollectionContext(calSql, id);
    const client = rt.client;
    const collection = meta.collection_name as string;
    const p = port;
    return await p.withCollectionWriteLock(id, async (lock) => {
      const [state]: StateRow[] = await lock.conn`
        SELECT sync_token, dir_mtime_ns::text AS dir_mtime_ns, health, hold_reason, pending_deletions, horizon_start, horizon_end
        FROM cal_collection_state WHERE calendar_id = ${id}
      `;
      if (!state || state.health !== 'hold') return emptyResult(id, startedAt, 'unchanged');
      const pending = new Set(state.pending_deletions);
      const target = opts.hrefs ? opts.hrefs.filter((h) => pending.has(h)) : [...pending];
      const indexRows: IndexedRow[] = await lock.conn`
        SELECT href, etag, health, pending_404_count FROM cal_objects WHERE calendar_id = ${id} AND href = ANY(${target}::text[])
      `;
      const indexed = new Map(indexRows.map((r) => [r.href, r]));
      const path = collectionPath(rt.principal, collection);
      const upserts: RawItem[] = [];
      const missing: string[] = [];
      let collectionGone = false;
      for (let i = 0; i < target.length && !collectionGone; i += INDEX_LIMITS.multigetBatch) {
        const chunk = target.slice(i, i + INDEX_LIMITS.multigetBatch);
        try {
          const res = await client.calendarMultiget(path, chunk.map((n) => objectPath(rt.principal, collection, n)));
          for (const obj of res.objects) {
            const name = nameOf(obj.href);
            if (name) upserts.push({ href: name, etag: obj.etag, raw: obj.data });
          }
          for (const href of res.missing) {
            const name = nameOf(href);
            if (name) missing.push(name);
          }
        } catch (err) {
          if (!isRadicaleError(err, 'not_found')) throw err;
          collectionGone = true; // la collezione intera non c'è più: tutto è cancellato
        }
      }
      if (collectionGone) missing.push(...target.filter((h) => !upserts.some((u) => u.href === h)));
      const dir = collectionDirPath(collection, rt);
      const diskUsable = !collectionGone && (currentWatchMode().mode === 'mount' || ((await isDirectory(dir)) && (await mountIsLocal(rt.dataDir)).local));
      const deletes: string[] = [];
      const radicaleSkipped: RawItem[] = [];
      for (const name of new Set(missing)) {
        if (diskUsable) {
          const disk = await readDiskItem(dir, name);
          if (disk.exists) {
            radicaleSkipped.push({ href: name, etag: indexed.get(name)?.etag ?? null, raw: disk.raw });
            continue;
          }
        }
        if (indexed.has(name)) deletes.push(name);
      }
      const decided = new Set(target);
      const remaining = [...pending].filter((h) => !decided.has(h)).sort();
      const horizon = state.horizon_start && state.horizon_end ? { start: state.horizon_start, end: state.horizon_end } : targetHorizon(new Date());
      const prepared = await p.prepareCollectionChanges(
        { context, upserts, deletes, radicaleSkipped, pending404: [], full: false, horizon, actor: opts.actor },
        { worker: 'auto' },
      );
      const applied = await p.applyPreparedChanges(lock, prepared, {
        hold: remaining.length ? { reason: state.hold_reason ?? HOLD_REASONS.massDelete, pendingDeletions: remaining } : null,
        syncedAt: new Date(),
      });
      log.info({ calendarId: id, collection, actor: opts.actor, deleted: deletes.length, restored: upserts.length, quarantined: radicaleSkipped.length, remaining: remaining.length }, 'cancellazioni sospese applicate dall\'admin');
      return buildResult({ id, startedAt, applied, full: false, syncToken: state.sync_token, dirMtimeNs: null, hold: remaining.length > 0, radicaleSkipped: radicaleSkipped.length, pending404: 0 });
    });
  } catch (err) {
    throw toSyncError(id, err, port);
  }
}

// Riesportato per watcher e freshness (marcatura delle modifiche osservate).
export { markCollectionDirty };
