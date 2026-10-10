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
 *    calendar_lifecycle): solo registrazione in memoria;
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
 *  - runSubscriptionIndexPull (ogni 15 minuti, accanto a ics-pull): pull delle
 *    iscrizioni verso l'indice in shadow, solo con lo store postgres. Con lo
 *    store Radicale lo fa già la facade (syncAllSubscriptions → pull.ts) nel
 *    cron ics-pull, e un secondo giro scaricherebbe i feed due volte. In mode
 *    postgres nessuno crea sidecar (fino alla F3) e il giro resta vuoto.
 *
 * L'arresto (stopCalendarBackground) ferma prima i produttori di lavoro
 * (canary, campanello con le sync in corso, worker dei job), poi il
 * worker_thread dell'indicizzatore e il listener del modo, e solo alla fine
 * chiude il pool calendario: le sync e i job lo usano fino all'ultimo.
 */

import { closeCalendarPool } from '../db';
import { readStoreKind, startBackendModeListener } from '../lib/calendar/backend-mode';
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
import { pullAllSubscriptionsToIndex } from '../lib/calendar/subscriptions/pull';
import { logger } from '../lib/logger';

const log = logger.child({ scope: 'calendar-radicale' });

/** Funzione che smette di ascoltare calendar_policy_changed (null se il listener non è partito). */
let stopModeListener: (() => Promise<void>) | null = null;
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
 * Cron ogni 15 minuti: pull delle iscrizioni verso l'indice in shadow (design
 * §6.6), solo con lo store postgres (con lo store Radicale lo fa già il cron
 * ics-pull attraverso la facade). Non lancia per un feed rotto: l'esito di
 * ogni iscrizione è nel risultato.
 */
export async function runSubscriptionIndexPull(): Promise<void> {
  if ((await readStoreKind()) !== 'postgres') return;
  await pullAllSubscriptionsToIndex();
}
