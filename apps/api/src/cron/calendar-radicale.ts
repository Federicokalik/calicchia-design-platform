/**
 * Avvio, arresto e cron del calendario su Radicale (fase F2; design §6.1,
 * §6.6, §6.8, §6.9, §16.5; contratto dei moduli
 * docs/calendar-radicale/contracts/f2-modules.md §1.5, §1.6 e §12).
 *
 * Cosa parte al boot (startCalendarBackground, da src/index.ts):
 *  - listener del modo (NOTIFY calendar_policy_changed → cache del modo
 *    invalidata). Non dipende da Radicale: serve alla facade in ogni modo, e
 *    senza la cache scade comunque in 2 s;
 *  - handler dei job (project_booking, booking_conflict_check,
 *    subscription_mirror, index_rebuild, recurrence_split,
 *    calendar_lifecycle, migration_run, shadow_mirror, reverse_projection):
 *    solo registrazione in memoria;
 *  - worker dei job, campanello (watcher) e canary: SOLO con Radicale
 *    configurato (RADICALE_URL). Senza, restano spenti e la salute
 *    (/api/health/calendar) li dichiara 'not_configured'/'off': l'API parte e
 *    in mode postgres funziona come prima della F2. Ogni job previsto parla
 *    con Radicale, quindi senza client non avrebbe nulla da fare.
 *
 * In mode postgres (produzione dopo il deploy della F2) i componenti accesi
 * lavorano in shadow come previsto dal design: il campanello sincronizza
 * l'indice solo con l'identità del volume 'ok', la discovery non crea righe
 * di `calendars`, nessun percorso legacy accoda job e nessun percorso di
 * contratto legge l'indice (contratto §1.5).
 *
 * Cron (registrati in cron/index.ts):
 *  - runCalendarHorizon (giornaliero): ensureHorizon, rimaterializzazione
 *    delle collezioni rimaste indietro dal testo indicizzato (nessun I/O verso
 *    Radicale). Spento senza Radicale configurato;
 *  - runCalendarNightlyAudit (notturno): runCalendarAudit (volume contro
 *    indice, identità, policy, sidecar, prenotazioni, orizzonte, retention di
 *    versioni e job). Spento senza Radicale configurato;
 *  - runCalendarMigrationReaper (ogni 5 minuti, F3): chiude come
 *    `interrupted` i run dello strumento di migrazione rimasti senza
 *    esecutore (reapInterruptedRuns). Spento senza Radicale configurato.
 *
 * Il pull delle iscrizioni verso l'indice con lo store postgres (cron
 * calendar-subscriptions-index della F2) è ora dentro il cron ics-pull
 * (contratto f3-modules §6.4): un secondo giro scaricherebbe i feed due volte.
 * I giri dello shadow mirror (runShadowNightly, runShadowHourlyParity) sono
 * registrati in cron/index.ts direttamente da lib/calendar/migration/shadow.
 *
 * Strumento di migrazione (F3, contratto f3-modules §15): gli handler dei job
 * `migration_run` (runs.ts) e `shadow_mirror` (shadow.ts) si registrano con
 * gli altri prima del worker; all'avvio, con Radicale configurato, un giro del
 * reaper chiude i run interrotti da un arresto senza ripresa possibile.
 *
 * Passaggio a Radicale (F4, contratto f4-modules §10): l'handler del job
 * `reverse_projection` si registra con gli altri; dopo il worker, con Radicale
 * configurato, parte il trigger della proiezione inversa (LISTEN
 * calendar_index_changed con debounce e giro di backstop a ogni
 * (ri)connessione) e si registra nel log una transizione rimasta attiva da un
 * arresto (cutover o rollback da riprendere dal wizard). Il trigger accoda
 * solo in mode radicale; il job rilegge mode e finestra dentro il lock. Cron
 * runCalendarReverseSweep (ogni 15 minuti): giro di backstop, solo in mode
 * radicale con la finestra di rollback aperta.
 *
 * L'arresto (stopCalendarBackground) ferma prima i produttori di lavoro
 * (canary, trigger della proiezione inversa, campanello con le sync in corso,
 * worker dei job), poi il
 * worker_thread dell'indicizzatore e il listener del modo, e solo alla fine
 * chiude il pool calendario: le sync e i job lo usano fino all'ultimo.
 */

import { closeCalendarPool } from '../db';
import { startBackendModeListener } from '../lib/calendar/backend-mode';
import { registerBookingJobs } from '../lib/calendar/booking';
import { startCalendarJobWorker, stopCalendarJobWorker } from '../lib/calendar/jobs';
import { runCalendarAudit } from '../lib/calendar/radicale/auditor';
import { startCanarySchedule, stopCanarySchedule } from '../lib/calendar/radicale/canary';
import { ensureHorizon } from '../lib/calendar/radicale/horizon';
import { stopIndexWorker } from '../lib/calendar/radicale/indexer';
import { ensureRequestedRebuild, registerIndexRebuildJob } from '../lib/calendar/radicale/rebuild';
import { registerStoreJobs } from '../lib/calendar/radicale/store';
import { radicaleRuntime } from '../lib/calendar/radicale/sync';
import { startCalendarWatcher, stopCalendarWatcher } from '../lib/calendar/radicale/watcher';
import { registerSubscriptionMirrorJob } from '../lib/calendar/subscriptions/mirror';
import { reapInterruptedRuns, registerMigrationRunJob } from '../lib/calendar/migration/runs';
import { registerShadowMirrorJob } from '../lib/calendar/migration/shadow';
import {
  registerReverseProjectionJob,
  runReverseProjectionSweep,
  startReverseProjectionTrigger,
} from '../lib/calendar/migration/reverse-projector';
import { readTransitionView } from '../lib/calendar/migration/transition';
import { registerCalendarHoldJobs } from '../lib/calendar/v2/hold';
import { registerCalendarImportJob } from '../lib/calendar/v2/import-export';
import { logger } from '../lib/logger';

const log = logger.child({ scope: 'calendar-radicale' });

/** Funzione che smette di ascoltare calendar_policy_changed (null se il listener non è partito). */
let stopModeListener: (() => Promise<void>) | null = null;
/** Funzione che ferma il trigger della proiezione inversa (null se non è partito). */
let stopReverseTrigger: (() => Promise<void>) | null = null;
/** Avvio in corso o concluso (idempotente). */
let starting: Promise<void> | null = null;
/** Arresto in corso (idempotente: SIGTERM e SIGINT ravvicinati lo chiamano due volte). */
let stopping: Promise<void> | null = null;

/**
 * true se il client di servizio di Radicale è configurato (RADICALE_URL e
 * credenziali valide). Nessun I/O: dice solo se i componenti di Radicale
 * possono partire, non se Radicale risponde.
 */
export function calendarRadicaleConfigured(): boolean {
  return radicaleRuntime().client !== null;
}

/** Perché i componenti di Radicale sono spenti (per i log del boot). */
function notConfiguredReason(): string {
  return radicaleRuntime().unavailableReason ?? 'Radicale non configurato';
}

/**
 * Avvia i componenti di processo del calendario (boot dell'API, dopo il
 * control-plane). Non lancia mai: un componente che non parte resta spento,
 * viene registrato nel log e si vede nella salute, ma non ferma l'API.
 */
export function startCalendarBackground(): Promise<void> {
  starting ??= startComponents();
  return starting;
}

async function startComponents(): Promise<void> {
  // 1. Listener del modo: facoltativo (la cache del modo scade comunque in 2 s).
  try {
    const unlisten = await startBackendModeListener();
    // Arresto arrivato durante l'avvio: non si lascia un LISTEN aperto.
    if (stopping) await unlisten().catch(() => {});
    else stopModeListener = unlisten;
  } catch (err) {
    log.warn({ err }, 'listener del modo del calendario non avviato: la cache del modo scade comunque in 2 s');
  }
  if (stopping) return;

  // 2. Handler dei job: registrazione in memoria, idempotente, nessun I/O.
  try {
    registerBookingJobs();
    registerSubscriptionMirrorJob();
    registerIndexRebuildJob();
    registerStoreJobs();
    // Strumento di migrazione (F3): run asincroni e shadow mirror.
    registerMigrationRunJob();
    registerShadowMirrorJob();
    // Passaggio a Radicale (F4): proiezione inversa nella finestra di rollback.
    registerReverseProjectionJob();
    // Admin v2 (F6): import di file ICS, azioni di hold.
    registerCalendarImportJob();
    registerCalendarHoldJobs();
  } catch (err) {
    log.error({ err }, 'registrazione degli handler dei job del calendario non riuscita');
  }

  if (!calendarRadicaleConfigured()) {
    log.info({ reason: notConfiguredReason() }, 'calendario su Radicale non configurato: worker dei job, campanello e canary spenti');
    // Senza client il campanello non parte: dichiara solo lo stato 'off' con
    // il motivo, che la salute riporta.
    await startCalendarWatcher().catch((err) => log.warn({ err }, 'stato del campanello non inizializzato'));
    return;
  }

  // 3. Worker dei job (giro ogni 5 s più NOTIFY calendar_jobs).
  try {
    await startCalendarJobWorker();
  } catch (err) {
    log.error({ err }, 'worker dei job del calendario non avviato');
  }
  if (stopping) return;

  // 3b. Rebuild richiesto senza job (restore-calendar-stack.sh, UPDATE manuale
  // dello stato): accodato subito invece che all'auditor delle 4.
  try {
    if (await ensureRequestedRebuild()) log.warn('rebuild dell\'indice richiesto dallo stato del backend: accodato all\'avvio');
  } catch (err) {
    log.warn({ err }, 'verifica del rebuild richiesto all\'avvio non riuscita: lo riaccoda l\'auditor notturno');
  }
  if (stopping) return;

  // 3c. Run dello strumento di migrazione rimasti senza esecutore (arresto
  // durante un run il cui job è morto o sparito): chiusi come `interrupted`
  // invece di aspettare il primo giro del reaper. Un run con il job ancora in
  // coda o in lease riprende da solo col worker appena avviato.
  try {
    const reaped = await reapInterruptedRuns();
    if (reaped > 0) log.warn({ reaped }, 'run dello strumento di migrazione interrotti chiusi all\'avvio');
  } catch (err) {
    log.warn({ err }, 'controllo dei run di migrazione interrotti all\'avvio non riuscito: lo ripete il reaper ogni 5 minuti');
  }
  if (stopping) return;

  // 3d. Transizione rimasta attiva (arresto durante un cutover o un rollback):
  // la policy resta frozen e Postgres resta autorevole finché non la si
  // riprende o annulla dal wizard (passo 6). Solo un log: nessuna ripresa
  // automatica, la decisione è dell'utente.
  try {
    const transition = await readTransitionView();
    if (transition && transition.status === 'active') {
      log.warn({
        transition: transition.id,
        kind: transition.kind,
        from: transition.from_mode,
        to: transition.target_mode,
        startedAt: transition.started_at,
      }, 'transizione del calendario rimasta attiva: riprenderla o annullarla dal wizard della migrazione');
    }
  } catch (err) {
    log.warn({ err }, 'lettura della transizione attiva all\'avvio non riuscita');
  }
  if (stopping) return;

  // 3e. Trigger della proiezione inversa (F4): accoda il job per collezione
  // sui NOTIFY dell'indice, solo in mode radicale con la finestra aperta.
  try {
    const stop = await startReverseProjectionTrigger();
    if (stopping) await stop().catch(() => {});
    else stopReverseTrigger = stop;
  } catch (err) {
    log.error({ err }, 'trigger della proiezione inversa non avviato: la recupera il giro di backstop ogni 15 minuti');
  }
  if (stopping) return;

  // 4. Campanello (stat del mount o remote mode) e canary all'avvio e ogni 10 minuti.
  try {
    await startCalendarWatcher();
  } catch (err) {
    log.error({ err }, 'campanello del calendario non avviato');
  }
  if (stopping) return;
  try {
    startCanarySchedule();
  } catch (err) {
    log.error({ err }, 'canary del calendario non pianificato');
  }
  log.info('componenti del calendario su Radicale avviati');
}

/**
 * Ferma i componenti di processo del calendario e chiude il pool calendario
 * (shutdown dell'API, prima di chiudere il pool principale). Idempotente; non
 * lancia mai.
 */
export function stopCalendarBackground(): Promise<void> {
  stopping ??= (async () => {
    const step = async (name: string, fn: () => unknown): Promise<void> => {
      try {
        await fn();
      } catch (err) {
        log.warn({ err }, `arresto del calendario: ${name} non riuscito`);
      }
    };
    // Un avvio in corso si ferma al passo successivo (vede `stopping`): lo si
    // attende, così nessun componente parte dopo l'arresto.
    await starting?.catch(() => {});
    // Prima i produttori di lavoro: canary, campanello (attende giro e sync in
    // corso fino a 5 s), worker dei job (attende il giro in corso).
    await step('canary', () => stopCanarySchedule());
    if (stopReverseTrigger) {
      const stopTrigger = stopReverseTrigger;
      stopReverseTrigger = null;
      await step('trigger della proiezione inversa', () => stopTrigger());
    }
    await step('campanello', () => stopCalendarWatcher());
    await step('worker dei job', () => stopCalendarJobWorker());
    await step('worker dell\'indicizzatore', () => stopIndexWorker());
    if (stopModeListener) {
      const unlisten = stopModeListener;
      stopModeListener = null;
      await step('listener del modo', () => unlisten());
    }
    // Per ultimo il pool calendario: sync, gate e job lo usano fino alla fine.
    await step('pool calendario', () => closeCalendarPool(5));
  })();
  return stopping;
}

// ─── Cron ───────────────────────────────

/**
 * Cron giornaliero: estende l'orizzonte dell'indice (design §6.9). Senza
 * Radicale configurato non fa nulla. Non lancia per una singola collezione
 * (ensureHorizon registra e manda l'alert); lancia solo se il database non
 * risponde, e il motore cron lo registra.
 */
export async function runCalendarHorizon(): Promise<void> {
  if (!calendarRadicaleConfigured()) return;
  const { extended, failed } = await ensureHorizon();
  if (failed.length > 0) {
    log.warn({ extended: extended.length, failed: failed.length }, 'orizzonte dell\'indice esteso solo in parte');
  }
}

/**
 * Cron notturno: auditor del calendario (design §6.8). Senza Radicale
 * configurato non fa nulla. Lancia solo con lo stato del backend
 * illeggibile: il motore cron lo registra (log e Bugsink) senza crash.
 */
export async function runCalendarNightlyAudit(): Promise<void> {
  if (!calendarRadicaleConfigured()) return;
  const report = await runCalendarAudit();
  log.info({
    identity: report.identity,
    policyCoherent: report.policyCoherent,
    reconciled: report.reconciled,
    collections: report.collections.length,
    alerts: report.alerts.length,
    durationMs: report.finishedAt.getTime() - report.startedAt.getTime(),
  }, 'audit notturno del calendario completato');
}

/**
 * Cron ogni 5 minuti: run dello strumento di migrazione rimasti senza
 * esecutore (contratto f3-modules §5.2 e §15). Senza Radicale configurato non
 * fa nulla: il worker dei job è spento e nessun run può partire. Lancia solo
 * se il database non risponde, e il motore cron lo registra.
 */
export async function runCalendarMigrationReaper(): Promise<void> {
  if (!calendarRadicaleConfigured()) return;
  const reaped = await reapInterruptedRuns();
  if (reaped > 0) log.warn({ reaped }, 'run dello strumento di migrazione interrotti chiusi dal reaper');
}

/**
 * Cron ogni 15 minuti (F4, contratto f4-modules §4.1 e §10): giro di backstop
 * della proiezione inversa. Accoda le collezioni con risorse non ancora
 * proiettate, REVERSE_FAILED, sparite o con prenotazioni cambiate; agisce
 * solo in mode radicale con la finestra di rollback aperta (lo controlla
 * runReverseProjectionSweep). Senza Radicale configurato non fa nulla.
 */
export async function runCalendarReverseSweep(): Promise<void> {
  if (!calendarRadicaleConfigured()) return;
  await runReverseProjectionSweep();
}
