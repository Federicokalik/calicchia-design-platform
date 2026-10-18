/**
 * Canary e statfs del campanello (fase F2 del passaggio a Radicale; design
 * §6.1 e revisione red-team punto 15; contratto dei moduli f2-modules.md
 * §4.2).
 *
 * Il campanello a stat poggia su due presupposti che vanno verificati, non
 * assunti: che il mount in sola lettura sia lo stesso volume che Radicale
 * scrive, e che la mtime delle directory si veda subito (NFS, CIFS e i driver
 * di rete hanno cache degli attributi che lo renderebbero cieco). All'avvio e
 * ogni 10 minuti:
 *  1. il mount (RADICALE_DATA_DIR) esiste;
 *  2. `fs.statfs` dà un filesystem locale (ext4, xfs, btrfs; elenco
 *     sostituibile solo nei test con CALDES_WATCH_FS_TYPES);
 *  3. l'identità del volume è `ok` (mai scritture su un volume estraneo);
 *  4. la collezione `_canary` esiste (nasce SOLO dall'inizializzazione
 *     esplicita: mai creata da qui);
 *  5. `caldes-svc` fa una PUT con If-Match (If-None-Match: * se `beat.ics`
 *     manca) su `_canary/beat.ics` e la mtime della directory deve cambiare
 *     via mount entro 100 ms dalla risposta.
 * Esito positivo → modalità `mount`; negativo → `remote` (disponibilità
 * ridotta, dichiarata con alert). `_canary` è nascosta ai device e il
 * watcher non la indicizza.
 */

import { statfs } from 'node:fs/promises';
import { join } from 'node:path';
import type { Logger } from 'pino';
import { logger as rootLogger } from '../../logger';
import { INDEX_TIMING } from '../index-model';
import { collectionPath, objectPath, type RadicaleClient } from './client';
import { DAV_PROPS } from './dav-xml';
import { isRadicaleError, type RadicaleError } from './errors';
import { acceptedFsTypes, describeFsType, radicaleRuntime, statMtimeNs, verifyVolumeIdentity, type WatchMode } from './sync';
import { CANARY_COLLECTION, RADICALE_COLLECTION_ROOT } from './types';
import { setWatchMode } from './watcher';

const log: Logger = rootLogger.child({ scope: 'calendar-canary' });

// ─── Tipi del contratto (f2-modules §4.2) ───────────────────

export type CanaryFailure =
  | 'not_configured'
  | 'mount_missing'
  | 'fs_not_local'
  | 'canary_missing'
  | 'put_failed'
  | 'mtime_not_observed'
  | 'radicale_unreachable'
  | 'identity_not_ok';

export interface CanaryResult {
  ok: boolean;
  mode: WatchMode;
  reason: CanaryFailure | null;
  /** Tipo di filesystem del mount, es. `ext4 (0xef53)` (null se non letto). */
  fsType: string | null;
  fsLocal: boolean | null;
  /** Ritardo fra la risposta della PUT e la mtime vista via mount (null se non osservata). */
  mtimeLagMs: number | null;
  checkedAt: Date;
  /** Dettaglio leggibile del fallimento (null se ok). */
  detail?: string | null;
}

/** Oggetto scritto dal canary. */
export const CANARY_OBJECT = 'beat.ics';
/** Timeout delle richieste del canary. */
const CANARY_TIMEOUT_MS = 5_000;
/** Pausa fra due stat durante l'attesa della mtime. */
const POLL_STEP_MS = 5;
/**
 * Distanza minima fra l'ultima modifica della directory e la PUT: con i
 * timestamp a grana grossa del kernel due modifiche ravvicinate possono avere
 * la stessa mtime e il canary fallirebbe senza motivo.
 */
const MIN_GAP_MS = 20;

let last: CanaryResult | null = null;
let inflight: Promise<CanaryResult> | null = null;
let timer: NodeJS.Timeout | null = null;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Ultimo esito del canary (null se mai eseguito). */
export function lastCanaryResult(): CanaryResult | null {
  return last;
}

/** Corpo di `beat.ics`: cambia a ogni giro (DTSTAMP e X-CALDES-CANARY), quindi cambia anche l'etag. */
function beatIcs(now: Date): string {
  const stamp = now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  return [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Caldes//calendar-canary//IT',
    'BEGIN:VEVENT',
    'UID:caldes-canary@caldes.it',
    `DTSTAMP:${stamp}`,
    'DTSTART:20000101T000000Z',
    'DTEND:20000101T000100Z',
    'SUMMARY:caldes canary',
    `X-CALDES-CANARY:${now.toISOString()}`,
    'END:VEVENT',
    'END:VCALENDAR',
    '',
  ].join('\r\n');
}

function failureOfRequest(err: unknown): CanaryFailure {
  return isRadicaleError(err) && (err as RadicaleError).transient ? 'radicale_unreachable' : 'put_failed';
}

function describe(err: unknown): string {
  return isRadicaleError(err) ? `${err.code}${err.status ? ` ${err.status}` : ''}` : (err as Error)?.message ?? String(err);
}

/**
 * Esegue il canary (vedi testa del file). Single-flight. Con `apply` (default
 * true) applica l'esito alla modalità del campanello: ok → mount; fallimento
 * → remote (alert); Radicale non configurato → off; identità non `ok` →
 * invariata (il watcher è già in pausa). Non lancia mai.
 */
export function runCanary(opts: { client?: RadicaleClient | null; dataDir?: string; signal?: AbortSignal; apply?: boolean } = {}): Promise<CanaryResult> {
  if (inflight) return inflight;
  inflight = execute(opts)
    .catch((err: unknown): CanaryResult => {
      log.error({ err }, 'canary del calendario fallito per un errore inatteso');
      return { ok: false, mode: 'remote', reason: 'put_failed', fsType: null, fsLocal: null, mtimeLagMs: null, checkedAt: new Date(), detail: describe(err) };
    })
    .then((result) => {
      last = result;
      if (opts.apply !== false) applyResult(result);
      return result;
    })
    .finally(() => {
      inflight = null;
    });
  return inflight;
}

function applyResult(result: CanaryResult): void {
  if (result.ok) {
    setWatchMode('mount', null);
    return;
  }
  if (result.reason === 'not_configured') setWatchMode('off', 'Radicale non configurato');
  else if (result.reason !== 'identity_not_ok') setWatchMode('remote', result.reason);
  if (result.reason !== 'identity_not_ok') {
    log.warn({ reason: result.reason, detail: result.detail, fsType: result.fsType }, 'canary del calendario non superato: remote mode');
  }
}

async function execute(opts: { client?: RadicaleClient | null; dataDir?: string; signal?: AbortSignal }): Promise<CanaryResult> {
  const rt = radicaleRuntime();
  const client = opts.client === undefined ? rt.client : opts.client;
  const dataDir = opts.dataDir ?? rt.dataDir;
  const checkedAt = new Date();
  let fsType: string | null = null;
  let fsLocal: boolean | null = null;
  const fail = (reason: CanaryFailure, detail: string | null, mode: WatchMode = 'remote'): CanaryResult => ({
    ok: false, mode, reason, fsType, fsLocal, mtimeLagMs: null, checkedAt, detail,
  });
  const aborted = (): boolean => opts.signal?.aborted === true;

  if (!client) return fail('not_configured', rt.unavailableReason, 'off');

  // 1-2. Mount e statfs.
  let type: number;
  try {
    type = Number((await statfs(dataDir)).type);
  } catch (err) {
    return fail('mount_missing', `${dataDir}: ${(err as NodeJS.ErrnoException).code ?? 'non accessibile'}`);
  }
  fsType = describeFsType(type);
  fsLocal = acceptedFsTypes().has(type);
  if (!fsLocal) return fail('fs_not_local', `filesystem ${fsType} non ammesso per il campanello`);
  if (aborted()) return fail('put_failed', 'interrotto');

  // 3. Identità.
  try {
    const { check } = await verifyVolumeIdentity();
    if (check.status !== 'ok') return fail('identity_not_ok', `identità del volume ${check.status}`, 'off');
  } catch (err) {
    return fail('identity_not_ok', describe(err), 'off');
  }

  // 4. _canary esiste (nasce solo dall'inizializzazione esplicita).
  const principal = rt.principal;
  try {
    const props = await client.readProps(collectionPath(principal, CANARY_COLLECTION), [DAV_PROPS.resourcetype], { timeoutMs: CANARY_TIMEOUT_MS });
    if (props === null) return fail('canary_missing', `collezione ${CANARY_COLLECTION} assente: va creata con l'inizializzazione esplicita (calendar:radicale-init -- --apply)`);
  } catch (err) {
    return fail(failureOfRequest(err), describe(err));
  }

  // 5. PUT e mtime via mount.
  const objPath = objectPath(principal, CANARY_COLLECTION, CANARY_OBJECT);
  const dir = join(dataDir, RADICALE_COLLECTION_ROOT, principal, CANARY_COLLECTION);
  for (let attempt = 1; attempt <= 2; attempt++) {
    if (aborted()) return fail('put_failed', 'interrotto');
    let etag: string | null = null;
    try {
      etag = (await client.get(objPath, { timeoutMs: CANARY_TIMEOUT_MS })).etag;
    } catch (err) {
      if (!isRadicaleError(err, 'not_found')) return fail(failureOfRequest(err), describe(err));
    }
    let before: bigint | null;
    try {
      before = await statMtimeNs(dir);
    } catch (err) {
      return fail('mtime_not_observed', `stat di ${dir}: ${(err as NodeJS.ErrnoException).code ?? 'errore'}`);
    }
    // Radicale ha _canary ma il mount non la vede: non è lo stesso volume (o è in ritardo).
    if (before === null) return fail('mtime_not_observed', `${dir} assente sul mount`);
    const age = Date.now() - Number(before / 1_000_000n);
    if (age >= 0 && age < MIN_GAP_MS) await sleep(MIN_GAP_MS - age);

    try {
      await client.put(objPath, beatIcs(new Date()), etag ? { ifMatch: etag } : { ifNoneMatch: '*' }, { timeoutMs: CANARY_TIMEOUT_MS });
    } catch (err) {
      // beat.ics cambiato fra GET e PUT (un altro processo): un secondo tentativo.
      if (attempt === 1 && isRadicaleError(err, 'precondition_failed')) continue;
      return fail(failureOfRequest(err), describe(err));
    }
    const answeredAt = performance.now();
    for (;;) {
      let now: bigint | null = null;
      try {
        now = await statMtimeNs(dir);
      } catch {
        now = null;
      }
      const elapsed = performance.now() - answeredAt;
      if (now !== null && now !== before) {
        return { ok: true, mode: 'mount', reason: null, fsType, fsLocal, mtimeLagMs: Math.round(elapsed), checkedAt, detail: null };
      }
      if (elapsed > INDEX_TIMING.canaryMtimeWindowMs) break;
      await sleep(POLL_STEP_MS);
    }
    return fail('mtime_not_observed', `mtime di ${CANARY_COLLECTION} invariata via mount ${INDEX_TIMING.canaryMtimeWindowMs} ms dopo la PUT`);
  }
  return fail('put_failed', 'precondizione fallita due volte');
}

/**
 * Canary all'avvio e ogni 10 minuti (idempotente). Non parte con
 * CALDES_WATCH=remote o off, né senza Radicale configurato.
 */
export function startCanarySchedule(): void {
  if (timer) return;
  const rt = radicaleRuntime();
  if (rt.watch === 'remote' || rt.watch === 'off' || !rt.client) {
    log.info({ watch: rt.watch, configured: !!rt.client }, 'canary del calendario non pianificato');
    return;
  }
  void runCanary();
  timer = setInterval(() => void runCanary(), INDEX_TIMING.canaryIntervalMs);
  timer.unref?.();
}

/** Ferma il canary periodico (spegnimento). Idempotente. */
export function stopCanarySchedule(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
