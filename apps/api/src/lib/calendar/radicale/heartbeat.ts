/**
 * Heartbeat dell'API e giro del control-plane verso Radicale (fase F1 del
 * passaggio del calendario a Radicale, piano T6; contratto control-plane §2,
 * §5.2 e §7; design §3.3, §13.1 e §16.6).
 *
 * Ogni giro (all'avvio, ogni HEARTBEAT_INTERVAL_MS = 30 s, a ogni NOTIFY
 * calendar_policy_changed e su richiesta dopo una transizione del processo):
 *  1. legge calendar_backend_state e il sidecar in un'unica istantanea, senza
 *     cache. Se la lettura fallisce il giro si ferma qui: niente policy nuova
 *     e niente heartbeat (contratto §2). Dopo 10 minuti senza heartbeat
 *     caldes_rights porta i device in frozen da solo;
 *  2. verifica l'identità del volume (identity.ts) contro lo stato appena letto;
 *  3. sincronizza policy.json con policyFromState() (policy.ts): la riscrive
 *     solo se il contenuto cambia o se il file manca o è invalido;
 *  4. scrive heartbeat.json con heartbeatFromState() e la stessa scrittura
 *     atomica. Il heartbeat si scrive solo se il passo 3 è riuscito: un
 *     heartbeat fresco accanto a una policy che non riflette lo stato
 *     terrebbe in vita permessi che lo stato non concede più (fail-closed:
 *     se policy.json non si scrive, entro 10 minuti i device vanno in frozen).
 *
 * I giri sono serializzati: una richiesta che arriva durante un giro ne
 * accoda uno solo dopo di esso (le richieste in coda si fondono). Gli errori
 * non fermano mai l'API: si registrano (una volta per serie, poi il rientro)
 * e compaiono in status().
 *
 * Avvio dal processo API: startCalendarControlPlane() in src/index.ts,
 * stopCalendarControlPlane() nello shutdown (ferma il timer, l'ascolto del
 * NOTIFY e attende il giro in corso). Attivazione con CALDES_CONTROL_PLANE
 * (auto: solo se la cartella di policy.json esiste, cioè con il volume
 * caldes_control montato).
 */

import { stat } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { Logger } from 'pino';
import { captureException } from '../../bugsink';
import { logger as rootLogger } from '../../logger';
import { radicaleClientFromEnv, type RadicaleClient } from './client';
import { checkVolumeIdentity, type IdentityCheck, type IdentitySource, resolveIdentitySource } from './identity';
import {
  type ControlPlaneConfig,
  controlPlaneConfigFromEnv,
  type Db,
  type PolicySyncResult,
  readControlFile,
  readPolicyFile,
  readPolicyInputs,
  syncPolicyFile,
  writeControlFileAtomic,
} from './policy';
import {
  type CalendarBackendState,
  type CaldesHeartbeat,
  type CaldesPolicy,
  type ControlFileRead,
  effectiveDeviceMode,
  type EffectiveDeviceMode,
  HEARTBEAT_INTERVAL_MS,
  heartbeatFromState,
  parseHeartbeat,
  serializeControlFile,
} from './types';

const LISTEN_CHANNEL = 'calendar_policy_changed';

// ─── File del heartbeat ───────────────────────────────

/** Scrive heartbeat.json per lo stato letto in questo giro (contratto §7.1). */
export async function writeHeartbeat(path: string, state: CalendarBackendState, apiVersion: string, now: Date): Promise<CaldesHeartbeat> {
  const heartbeat = heartbeatFromState(state, apiVersion, now);
  await writeControlFileAtomic(path, serializeControlFile(heartbeat));
  return heartbeat;
}

/** heartbeat.json letto con le regole di parseHeartbeat(). */
export function readHeartbeatFile(path: string): Promise<ControlFileRead<CaldesHeartbeat>> {
  return readControlFile(path, parseHeartbeat);
}

/**
 * Modalità effettiva dei device come la calcola caldes_rights dai file su
 * disco in questo istante (contratto §7.3): per la salute e per i test.
 */
export async function effectiveModeFromFiles(opts: {
  policyFile: string;
  heartbeatFile: string;
  principal: string;
  now?: Date;
  lastKnownGood?: CaldesPolicy | null;
}): Promise<EffectiveDeviceMode & { policy: ControlFileRead<CaldesPolicy>; heartbeat: ControlFileRead<CaldesHeartbeat> }> {
  const [policy, heartbeat] = await Promise.all([readPolicyFile(opts.policyFile, opts.principal), readHeartbeatFile(opts.heartbeatFile)]);
  const effective = effectiveDeviceMode({ policy, heartbeat, lastKnownGood: opts.lastKnownGood ?? null, now: opts.now ?? new Date() });
  return { ...effective, policy, heartbeat };
}

// ─── Giro del control-plane ───────────────────────────────

export type TickTrigger = 'start' | 'interval' | 'notify' | 'reconnect' | 'manual';

/** Esito di un giro. */
export interface ControlPlaneTick {
  trigger: TickTrigger;
  startedAt: string;
  finishedAt: string;
  ok: boolean;
  /** Passo in cui il giro si è fermato (solo se ok è false). */
  failedStage: 'state' | 'policy' | 'heartbeat' | null;
  error: string | null;
  state: Pick<CalendarBackendState, 'mode' | 'epoch' | 'policy_version' | 'credential_epoch'> | null;
  identity: IdentityCheck | null;
  policy: {
    written: boolean;
    previous: PolicySyncResult['previous'];
    mode: CaldesPolicy['mode'];
    version: number;
    reasons: CaldesPolicy['reasons'];
  } | null;
  heartbeat: { ts: string } | null;
}

/** Stato del control-plane per la salute (design §16.5). */
export interface ControlPlaneStatus {
  running: boolean;
  listening: boolean;
  policyFile: string;
  heartbeatFile: string;
  identitySource: string;
  lastTick: ControlPlaneTick | null;
  lastSuccessAt: string | null;
  lastPolicyWriteAt: string | null;
  lastHeartbeatAt: string | null;
  consecutiveFailures: number;
}

export interface ControlPlaneOptions {
  /** Pool di postgres-js (serve listen() per il NOTIFY). */
  db: Db;
  policyFile: string;
  heartbeatFile: string;
  principal: string;
  apiVersion: string;
  identitySource: IdentitySource;
  /** Intervallo del heartbeat (default 30 s; i test lo accorciano). */
  intervalMs?: number;
  /** Ascolta NOTIFY calendar_policy_changed (default true; richiede il pool, non una transazione). */
  listen?: boolean;
  /** Orologio (test). */
  now?: () => Date;
  logger?: Logger;
  /** Chiamata alla fine di ogni giro (test, metriche). */
  onTick?: (tick: ControlPlaneTick) => void;
  /** Risorse da chiudere allo stop (es. il client della sorgente remota). */
  onStop?: () => void | Promise<void>;
}

/**
 * Writer di policy.json e heartbeat.json. Un'istanza per processo
 * (startCalendarControlPlane); i test ne creano di proprie.
 */
export class CalendarControlPlane {
  private readonly opts: ControlPlaneOptions;
  private readonly log: Logger;
  private readonly intervalMs: number;
  private readonly now: () => Date;
  private timer: NodeJS.Timeout | null = null;
  private started = false;
  private stopped = false;
  private inFlight: Promise<ControlPlaneTick> | null = null;
  private queued: Promise<ControlPlaneTick> | null = null;
  private unlisten: (() => Promise<void>) | null = null;
  private listenAttempt: Promise<void> | null = null;
  private listenUnsupported = false;
  private listenWarned = false;
  private listenStarted = false;
  private lastTick: ControlPlaneTick | null = null;
  private lastSuccessAt: string | null = null;
  private lastPolicyWriteAt: string | null = null;
  private lastHeartbeatAt: string | null = null;
  private consecutiveFailures = 0;
  private lastErrorKey: string | null = null;
  private lastIdentityStatus: string | null = null;

  constructor(opts: ControlPlaneOptions) {
    this.opts = opts;
    this.log = opts.logger ?? rootLogger.child({ scope: 'calendar-control-plane' });
    this.intervalMs = opts.intervalMs ?? HEARTBEAT_INTERVAL_MS;
    if (!Number.isInteger(this.intervalMs) || this.intervalMs < 10) throw new TypeError(`intervalMs non valido: ${this.intervalMs}`);
    this.now = opts.now ?? (() => new Date());
  }

  /**
   * Avvia l'ascolto del NOTIFY, il primo giro subito e poi il timer
   * periodico. Restituisce l'esito del primo giro: chi non vuole attenderlo
   * (il boot dell'API) ignora la promessa. Idempotente.
   */
  async start(): Promise<ControlPlaneTick> {
    if (this.started) return this.lastTick ?? this.syncNow('manual');
    this.started = true;
    this.ensureListening();
    const first = this.syncNow('start');
    void first.finally(() => this.schedule());
    return first;
  }

  /** Ferma timer e ascolto e attende il giro in corso. Idempotente. */
  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const unlisten = this.unlisten;
    this.unlisten = null;
    if (unlisten) await unlisten().catch((err) => this.log.warn({ err }, 'unlisten del NOTIFY non riuscito'));
    // Un LISTEN ancora in corso si rilascia da sé quando vede `stopped`.
    await Promise.allSettled([this.queued, this.inFlight, this.listenAttempt].filter(Boolean) as Promise<unknown>[]);
    await this.opts.onStop?.();
  }

  /**
   * Esegue un giro (dopo quello in corso, se c'è). Le richieste che arrivano
   * mentre un giro è in coda si fondono in quello. Non lancia mai.
   */
  syncNow(trigger: TickTrigger = 'manual'): Promise<ControlPlaneTick> {
    if (this.stopped) return Promise.resolve(this.skippedTick(trigger));
    if (this.queued) return this.queued;
    const previous = this.inFlight;
    const queued = (async (): Promise<ControlPlaneTick> => {
      // Sempre almeno un passaggio di microtask: `this.queued` è assegnato
      // prima che il giro parta, e da qui in poi una nuova richiesta si
      // accoda dietro questo giro invece di fondersi con esso.
      await (previous ? previous.catch(() => undefined) : undefined);
      this.queued = null;
      const run = this.tick(trigger);
      this.inFlight = run;
      try {
        return await run;
      } finally {
        if (this.inFlight === run) this.inFlight = null;
      }
    })();
    this.queued = queued;
    return queued;
  }

  status(): ControlPlaneStatus {
    return {
      running: this.started && !this.stopped,
      listening: this.unlisten !== null,
      policyFile: this.opts.policyFile,
      heartbeatFile: this.opts.heartbeatFile,
      identitySource: `${this.opts.identitySource.kind}: ${this.opts.identitySource.description}`,
      lastTick: this.lastTick,
      lastSuccessAt: this.lastSuccessAt,
      lastPolicyWriteAt: this.lastPolicyWriteAt,
      lastHeartbeatAt: this.lastHeartbeatAt,
      consecutiveFailures: this.consecutiveFailures,
    };
  }

  // ── interni ──

  private schedule(): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.syncNow('interval').finally(() => this.schedule());
    }, this.intervalMs);
    this.timer.unref();
  }

  /**
   * Avvia l'ascolto del NOTIFY se richiesto e non ancora attivo. Si richiama
   * dopo ogni giro riuscito: se il LISTEN è fallito all'avvio (DB giù), riparte
   * appena il database risponde. Una volta attivo, postgres-js riconnette da sé.
   */
  private ensureListening(): void {
    if (this.opts.listen === false || this.listenUnsupported || this.stopped || this.unlisten || this.listenAttempt) return;
    this.listenAttempt = this.startListening().finally(() => {
      this.listenAttempt = null;
    });
  }

  private async startListening(): Promise<void> {
    const db = this.opts.db;
    if (typeof (db as Partial<Db>).listen !== 'function') {
      this.listenUnsupported = true;
      this.log.warn('NOTIFY non disponibile su questa connessione: solo giro periodico');
      return;
    }
    try {
      const meta = await db.listen(
        LISTEN_CHANNEL,
        () => void this.syncNow('notify'),
        () => {
          // onlisten scatta a ogni (ri)connessione: dopo la prima, le notifiche
          // perse durante la disconnessione si recuperano con un giro subito.
          if (this.listenStarted) void this.syncNow('reconnect');
          this.listenStarted = true;
        },
      );
      if (this.stopped) {
        await meta.unlisten().catch(() => undefined);
        return;
      }
      this.unlisten = () => meta.unlisten();
      if (this.listenWarned) this.log.info('LISTEN calendar_policy_changed attivo');
      this.listenWarned = false;
    } catch (err) {
      // Una riga per serie: si ritenta dopo ogni giro riuscito.
      if (!this.listenWarned) this.log.warn({ err }, 'LISTEN calendar_policy_changed non riuscito: solo giro periodico, nuovo tentativo al prossimo giro');
      this.listenWarned = true;
    }
  }

  private skippedTick(trigger: TickTrigger): ControlPlaneTick {
    const at = this.now().toISOString();
    return { trigger, startedAt: at, finishedAt: at, ok: false, failedStage: null, error: 'control-plane fermato', state: null, identity: null, policy: null, heartbeat: null };
  }

  private async tick(trigger: TickTrigger): Promise<ControlPlaneTick> {
    const startedAt = this.now();
    const tick: ControlPlaneTick = {
      trigger,
      startedAt: startedAt.toISOString(),
      finishedAt: startedAt.toISOString(),
      ok: false,
      failedStage: null,
      error: null,
      state: null,
      identity: null,
      policy: null,
      heartbeat: null,
    };
    const fail = (stage: NonNullable<ControlPlaneTick['failedStage']>, err: unknown): ControlPlaneTick => {
      tick.failedStage = stage;
      tick.error = err instanceof Error ? err.message || err.name : String(err);
      return this.record(tick, err);
    };

    // 1. Stato e sidecar. Senza stato non si scrive nulla.
    let inputs: Awaited<ReturnType<typeof readPolicyInputs>>;
    try {
      inputs = await readPolicyInputs(this.opts.db);
    } catch (err) {
      return fail('state', err);
    }
    const { state } = inputs;
    tick.state = { mode: state.mode, epoch: state.epoch, policy_version: state.policy_version, credential_epoch: state.credential_epoch };

    // 2. Identità (non lancia: un errore vale come non verificata).
    const identity = await checkVolumeIdentity(state, this.opts.identitySource, this.opts.principal, this.now());
    tick.identity = identity;
    this.noteIdentity(identity);

    // 3. Policy.
    let synced: PolicySyncResult;
    try {
      synced = await syncPolicyFile({ ...inputs, file: this.opts.policyFile, identity: identity.status, principal: this.opts.principal, now: this.now() });
    } catch (err) {
      return fail('policy', err);
    }
    tick.policy = {
      written: synced.written,
      previous: synced.previous,
      mode: synced.onDisk.mode,
      version: synced.onDisk.version,
      reasons: synced.onDisk.reasons,
    };
    if (synced.written) {
      this.lastPolicyWriteAt = this.now().toISOString();
      this.log.info(
        { mode: synced.derived.mode, version: synced.derived.version, reasons: synced.derived.reasons, previous: synced.previous, previousError: synced.previousError, trigger },
        'policy.json aggiornata',
      );
    }

    // 4. Heartbeat, solo con la policy allineata allo stato.
    try {
      const heartbeat = await writeHeartbeat(this.opts.heartbeatFile, state, this.opts.apiVersion, this.now());
      tick.heartbeat = { ts: heartbeat.ts };
      this.lastHeartbeatAt = heartbeat.ts;
    } catch (err) {
      return fail('heartbeat', err);
    }

    tick.ok = true;
    this.ensureListening();
    return this.record(tick, null);
  }

  private noteIdentity(identity: IdentityCheck): void {
    const key = `${identity.status}|${identity.detail ?? ''}`;
    if (key === this.lastIdentityStatus) return;
    const first = this.lastIdentityStatus === null;
    this.lastIdentityStatus = key;
    const fields = { status: identity.status, source: identity.source, detail: identity.detail, marker: identity.marker };
    if (identity.status === 'mismatch' || identity.status === 'unverified') {
      this.log.warn(fields, 'identità del volume di Radicale non verificata: policy frozen');
    } else if (!first || identity.status === 'ok') {
      this.log.info(fields, 'identità del volume di Radicale');
    }
  }

  private record(tick: ControlPlaneTick, err: unknown): ControlPlaneTick {
    tick.finishedAt = this.now().toISOString();
    this.lastTick = tick;
    if (tick.ok) {
      if (this.consecutiveFailures > 0) {
        this.log.info({ failures: this.consecutiveFailures }, 'control-plane di nuovo regolare');
      }
      this.consecutiveFailures = 0;
      this.lastErrorKey = null;
      this.lastSuccessAt = tick.finishedAt;
    } else {
      this.consecutiveFailures++;
      // Una riga (e un evento Bugsink) per serie di errori uguali, non ogni 30 s.
      const key = `${tick.failedStage}|${tick.error}`;
      if (key !== this.lastErrorKey) {
        this.lastErrorKey = key;
        this.log.error({ err, stage: tick.failedStage, trigger: tick.trigger }, 'giro del control-plane non riuscito: policy e heartbeat non aggiornati');
        captureException(err instanceof Error ? err : new Error(String(err)), { source: 'calendar-control-plane', stage: tick.failedStage });
      }
    }
    try {
      this.opts.onTick?.(tick);
    } catch {
      /* il callback non deve fermare il giro */
    }
    return tick;
  }
}

// ─── Istanza del processo API ───────────────────────────────

let instance: CalendarControlPlane | null = null;

/**
 * Avvia il control-plane del processo API secondo l'ambiente (contratto
 * §1.3): CALDES_CONTROL_PLANE, CALDES_POLICY_FILE, CALDES_HEARTBEAT_FILE,
 * RADICALE_PRINCIPAL, RADICALE_DATA_DIR, CALDES_IDENTITY_SOURCE, RADICALE_URL
 * e RADICALE_SVC_PASSWORD (sorgente remota), CALDES_API_VERSION.
 * Restituisce null se disattivato. Non attende il primo giro.
 */
export async function startCalendarControlPlane(env: NodeJS.ProcessEnv = process.env): Promise<CalendarControlPlane | null> {
  if (instance) return instance;
  const log = rootLogger.child({ scope: 'calendar-control-plane' });
  let config: ControlPlaneConfig;
  try {
    config = controlPlaneConfigFromEnv(env);
  } catch (err) {
    log.error({ err }, 'configurazione del control-plane non valida: policy e heartbeat non vengono scritti');
    captureException(err as Error, { source: 'calendar-control-plane', stage: 'config' });
    return null;
  }
  if (config.activation === 'off') {
    log.info('control-plane di Radicale disattivato (CALDES_CONTROL_PLANE=off)');
    return null;
  }
  const dir = dirname(config.policyFile);
  const dirInfo = await stat(dir).catch(() => null);
  if (config.activation === 'auto' && !dirInfo?.isDirectory()) {
    log.info({ dir }, 'control-plane di Radicale non attivo: cartella di caldes_control assente (CALDES_CONTROL_PLANE=on per forzarlo)');
    return null;
  }
  // Contratto §1.1: file 0644 in una cartella 0755, scrivibile solo dall'API. La
  // cartella è il volume montato: i permessi li fissa il deploy, qui si segnalano.
  if (dirInfo && (dirInfo.mode & 0o022) !== 0) {
    log.warn({ dir, mode: (dirInfo.mode & 0o777).toString(8) }, 'cartella di caldes_control scrivibile da gruppo o altri: il contratto prevede 0755');
  }

  let client: RadicaleClient | null = null;
  try {
    // Client dedicato alla verifica dell'identità: timeout brevi, il giro resta sotto i 30 s.
    client = radicaleClientFromEnv(env, { timeoutMs: 5_000, retries: 1 });
  } catch (err) {
    log.error({ err }, 'client Radicale non configurabile: identità verificabile solo dal mount');
  }
  const identitySource = await resolveIdentitySource(config.identitySource, config.dataDir, client);
  if (identitySource.kind !== 'remote') client?.close();

  const { sql } = await import('../../../db');
  instance = new CalendarControlPlane({
    db: sql,
    policyFile: config.policyFile,
    heartbeatFile: config.heartbeatFile,
    principal: config.principal,
    apiVersion: config.apiVersion,
    identitySource,
    logger: log,
    onStop: () => {
      if (identitySource.kind === 'remote') client?.close();
    },
  });
  log.info(
    { policyFile: config.policyFile, heartbeatFile: config.heartbeatFile, identity: `${identitySource.kind}: ${identitySource.description}`, apiVersion: config.apiVersion },
    'control-plane di Radicale avviato',
  );
  void instance.start();
  return instance;
}

/** Ferma il control-plane del processo (shutdown). Idempotente. */
export async function stopCalendarControlPlane(): Promise<void> {
  const current = instance;
  instance = null;
  await current?.stop();
}

/** Istanza attiva (null se disattivata o non avviata). */
export function getCalendarControlPlane(): CalendarControlPlane | null {
  return instance;
}

/**
 * Giro immediato dopo una transizione fatta dal processo (contratto §5.2),
 * per esempio dopo l'incremento di credential_epoch. Il NOTIFY della 162 lo
 * provoca comunque; questa chiamata permette di attenderne l'esito. null se
 * il control-plane non è attivo.
 */
export async function requestControlPlaneSync(): Promise<ControlPlaneTick | null> {
  return instance ? instance.syncNow('manual') : null;
}
