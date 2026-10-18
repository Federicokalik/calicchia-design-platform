/**
 * Cutover a Radicale (fase F4 del passaggio a Radicale; design §13.10, con lo
 * schema delle transizioni del §13.9; contratto docs/calendar-radicale/
 * contracts/f4-modules.md §3). È il run `cutover` dello strumento di
 * migrazione, avviato dal passo 6 del wizard con la conferma digitata
 * `PASSA A RADICALE`: fino a quel momento Postgres resta autorevole e nulla di
 * questo modulo gira.
 *
 * Passi (CUTOVER_STEPS, ognuno nel journal di transition.ts e riprendibile):
 *
 *  1. preflight      criteri del §3.2 (verifica V1-V5 accettabile dopo
 *                    l'ultimo apply, parità dello shadow, matrice device,
 *                    backup coordinato di meno di 2 ore, nessun conflitto,
 *                    control-plane, probe, archivio in sola lettura...).
 *                    Fallito → run fallito, transizione aperta e annullabile,
 *                    nessuno stato toccato;
 *  2. freeze         mode `cutover`, write_freeze (prima lo stato, poi la
 *                    policy frozen derivata);
 *  3. quiesce        gate cal-write esclusivo e quiescenza dei device;
 *  4. delta_apply    apply completo con le opzioni e l'ambito dell'ultima
 *                    anteprima (buildPlan ed executePlanItem della F3, mode
 *                    cutover): conflitti, fallimenti o anomalie bloccanti →
 *                    annullamento (ritorno a postgres con policy shadow);
 *  5. delta_verify   V1, V2 e V4 (180 giorni, senza iscrizioni) su tutti i
 *                    calendari con le accettazioni riportate per firma; non
 *                    accettabile → annullamento (VERIFY_RED);
 *  6. epoch          PUNTO DI NON RITORNO: PROPPATCH dell'epoch E+1 sul
 *                    principal, poi in una transazione mode `radicale`,
 *                    rollback_until, cutover_at/by, api_min_version
 *                    (write_freeze resta attivo);
 *  7. control_plane  policy frozen (write_freeze) con il nuovo epoch,
 *                    heartbeat `radicale`, identità `ok`;
 *  8. index_sync     validatori delle iscrizioni azzerati, sync di tutte le
 *                    collezioni (indice allineato al nuovo epoch);
 *  9. reverse_start  prima passata completa della proiezione inversa;
 * 10. bookings_reconcile  project_booking per le prenotazioni create o
 *                    cambiate a cavallo del freeze;
 * 11. unfreeze       write_freeze = false: policy live, i device scrivono;
 * 12. smoke          smoke senza effetti collaterali (smoke.ts): un
 *                    fallimento non annulla il cutover, il wizard propone il
 *                    rollback.
 *
 * Ripresa: un crash in qualunque passo lascia la transizione attiva con lo
 * stato già scritto. Prima del passo d'epoch la si riprende (stesso run dopo
 * il lease scaduto, o un run nuovo con action 'resume') o la si annulla
 * (action 'abort': ritorno a postgres con la policy shadow e il write_freeze
 * di prima); dopo, si riprende e basta (per tornare indietro c'è il rollback).
 *
 * Postgres resta la fonte della fotografia fino al passo d'epoch: dal freeze
 * nessuno lo scrive più (la guardia 166 rifiuta le scritture fuori da mode
 * postgres, la facade risponde 503 'transition'), i device sono in sola
 * lettura (policy frozen) e la quiescenza lo ha verificato prima del delta.
 * Dopo il passo d'epoch la facade usa RadicaleStore (backend-mode.ts) e
 * calendar_events è protetta dalla guardia 166: la scrive solo la proiezione
 * inversa con il GUC caldes.reverse_sync.
 */

import type { Logger } from 'pino';
import { logger as rootLogger } from '../../logger';
import { CAL_JOB_KINDS, enqueueCalendarJob } from '../jobs';
import type { RadicaleClient } from '../radicale/client';
import { type ControlPlaneStatus, type ControlPlaneTick, getCalendarControlPlane, requestControlPlaneSync } from '../radicale/heartbeat';
import { checkVolumeIdentity, type IdentityCheck, remoteIdentitySource } from '../radicale/identity';
import { type Db, readSidecarCollections, resolveApiVersion } from '../radicale/policy';
import { CollectionSyncError, type SyncCollectionResult, syncAllCollections, verifyVolumeIdentity } from '../radicale/sync';
import { type BackendMode, DEFAULT_PRINCIPAL, policyFromState } from '../radicale/types';
import { applyItemRow, executePlanItem, type ExecuteContext, type ExecutedItem, migrationThrottle } from './apply';
import { buildPlan } from './plan';
import { assertMigrationWritable, describeRadicaleError, preconditionError, requireRadicale } from './preflight';
import { latestVerifyVerdicts } from './report';
import { countOpenShadowConflicts, getParity, referencePlan } from './shadow';
import { runCutoverSmoke } from './smoke';
import {
  abortTransition,
  beginTransition,
  completedStep,
  completeTransition,
  epochStep,
  freezeStep,
  getActiveTransition,
  getLatestTransition,
  journalViews,
  mergeTransitionData,
  pastPointOfNoReturn,
  type QuiescenceDeps,
  quiesceStep,
  readJournal,
  readTransitionState,
  runStep,
  stateStep,
  type TransitionContext,
  transitionContextFromRun,
  TransitionError,
  type TransitionHandle,
} from './transition';
import {
  ANOMALY_DEFINITIONS,
  type ApplyOutcome,
  type ApplySummary,
  CALENDAR_API_LEVEL,
  CONFLICT_CODES,
  type ConflictCode,
  CUTOVER_STEPS,
  type CutoverCriterion,
  type CutoverParams,
  type CutoverSummary,
  emptyOutcomeCounts,
  F4_LIMITS,
  isWriteAction,
  type MigrationBackendState,
  MigrationError,
  type MigrationItemInput,
  MIGRATION_LIMITS,
  type MigrationRunContext,
  type MigrationScope,
  type ParityView,
  type PlanItem,
  type PreconditionReason,
  type QuiescenceReport,
  type ReverseApplySummary,
  type SmokeReport,
  type VerifyParams,
  type VerifySummary,
} from './types';
import { runVerifyWithGuard } from './verify';

const log: Logger = rootLogger.child({ scope: 'calendar-cutover' });

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
const MINUTE_MS = 60_000;
/** Righe dell'apply accumulate prima di un salvataggio (avanzamento visibile nel wizard). */
const ROWS_FLUSH_EVERY = 50;
/** Il contratto dei run ammette al più 500 righe per addItems. */
const ROWS_CHUNK = 500;
/** Livelli e orizzonte della verifica del delta (design §13.10 passo 3, contratto §3.1). */
const DELTA_VERIFY_LEVELS = ['V1', 'V2', 'V4'] as const;
const DELTA_VERIFY_V4_DAYS = 180;
/** Tentativi del giro del control-plane dopo il passo d'epoch. */
const CONTROL_PLANE_ATTEMPTS = 5;
const CONTROL_PLANE_RETRY_MS = 1_000;
/** Timeout della lettura del marker per le guardie d'identità. */
const IDENTITY_TIMEOUT_MS = 8_000;
const CONFLICT_SET: ReadonlySet<string> = new Set<string>(CONFLICT_CODES);

// ─── Finestra di rollback ───────────────────────────────

/**
 * Giorni della finestra di rollback proposti dal wizard: CAL_ROLLBACK_WINDOW_DAYS
 * (contratto §10) se è un intero fra F4_LIMITS.rollbackWindowMinDays e
 * rollbackWindowMaxDays, altrimenti F4_LIMITS.rollbackWindowDays (30).
 */
export function defaultRollbackWindowDays(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.CAL_ROLLBACK_WINDOW_DAYS?.trim();
  if (!raw) return F4_LIMITS.rollbackWindowDays;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < F4_LIMITS.rollbackWindowMinDays || n > F4_LIMITS.rollbackWindowMaxDays) {
    log.warn({ value: raw }, `CAL_ROLLBACK_WINDOW_DAYS non valido (atteso un intero fra ${F4_LIMITS.rollbackWindowMinDays} e ${F4_LIMITS.rollbackWindowMaxDays}): uso ${F4_LIMITS.rollbackWindowDays}`);
    return F4_LIMITS.rollbackWindowDays;
  }
  return n;
}

function validWindowDays(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= F4_LIMITS.rollbackWindowMinDays && value <= F4_LIMITS.rollbackWindowMaxDays ? value : null;
}

/** Parametri del run normalizzati (VALIDATION_FAILED se fuori contratto). */
export function normalizeCutoverParams(params: Partial<CutoverParams> | null | undefined, env: NodeJS.ProcessEnv = process.env): CutoverParams {
  const p = params ?? {};
  const action = p.action ?? 'start';
  if (action !== 'start' && action !== 'resume' && action !== 'abort') {
    throw new MigrationError('VALIDATION_FAILED', 'action: attesi start, resume o abort');
  }
  let days = defaultRollbackWindowDays(env);
  if (p.rollback_window_days !== undefined && p.rollback_window_days !== null) {
    const v = validWindowDays(p.rollback_window_days);
    if (v === null) {
      throw new MigrationError('VALIDATION_FAILED', `rollback_window_days: atteso un intero fra ${F4_LIMITS.rollbackWindowMinDays} e ${F4_LIMITS.rollbackWindowMaxDays}`);
    }
    days = v;
  }
  const verify = p.verify_run_id ?? null;
  if (verify !== null && (typeof verify !== 'string' || !UUID_RE.test(verify))) {
    throw new MigrationError('VALIDATION_FAILED', 'verify_run_id: atteso l\'id (UUID) di un run di verifica');
  }
  return { action, rollback_window_days: days, verify_run_id: verify ? verify.toLowerCase() : null };
}

// ─── Criteri (§3.2) ───────────────────────────────

/** Dipendenze dei criteri sostituibili nei test (Radicale, control-plane, probe). */
export interface CutoverCriteriaDeps {
  /** Guardia di scrittura dello strumento: mode postgres e identità `ok` letta da Radicale. */
  assertWritable: (db: Db) => Promise<MigrationBackendState>;
  /** Stato del control-plane del processo (null se non attivo). */
  controlPlaneStatus: () => ControlPlaneStatus | null;
  /** Password di caldes-probe disponibile nell'API. */
  probeAvailable: () => boolean;
  /** Principal di Radicale (per la policy derivata dell'archivio). */
  principal: () => string;
  /** Versione dell'immagine dell'API (CALDES_API_VERSION o sha-<short>; 'unversioned' se assente). */
  apiVersion: () => string;
}

/** Dipendenze di produzione dei criteri. */
export function defaultCutoverCriteriaDeps(env: NodeJS.ProcessEnv = process.env): CutoverCriteriaDeps {
  return {
    assertWritable: async (db) => {
      const { client, principal } = requireRadicale();
      return assertMigrationWritable({ db, client, principal });
    },
    controlPlaneStatus: () => getCalendarControlPlane()?.status() ?? null,
    probeAvailable: () => Boolean(env.RADICALE_PROBE_PASSWORD?.trim() || env.CALDES_PROBE_PASSWORD?.trim()),
    principal: () => env.RADICALE_PRINCIPAL?.trim() || DEFAULT_PRINCIPAL,
    apiVersion: () => resolveApiVersion(env),
  };
}

/** Criterio con il motivo da riportare se non soddisfatto (null per i criteri solo informativi). */
interface CriterionEval extends CutoverCriterion {
  reason: PreconditionReason | null;
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

function iso(d: Date | null | undefined): string | null {
  return d ? d.toISOString() : null;
}

/** Fine dell'ultimo apply riuscito che ha scritto qualcosa (stessa regola del wizard della F3). */
async function lastWritingApplyAt(db: Db): Promise<Date | null> {
  const [row] = await db<Array<{ finished_at: Date }>>`
    SELECT finished_at FROM cal_migration_runs
    WHERE kind = 'apply' AND status = 'succeeded' AND finished_at IS NOT NULL
      AND COALESCE(summary->>'zero_writes', 'false') <> 'true'
    ORDER BY finished_at DESC
    LIMIT 1
  `;
  return row?.finished_at ?? null;
}

async function evaluateCriteria(
  db: Db,
  opts: { now: Date; verifyRunId: string | null; transitionId: string | null; deps: CutoverCriteriaDeps },
): Promise<CriterionEval[]> {
  const { now, deps } = opts;
  const state = await readTransitionState(db);
  const out: CriterionEval[] = [];

  // Nessuna transizione attiva (o quella che si sta riprendendo).
  const active = await getActiveTransition(db);
  const otherActive = active && active.id !== opts.transitionId ? active : null;
  out.push({
    id: 'no_active_transition',
    label: 'Nessun\'altra transizione in corso (passaggio, rollback o chiusura della finestra)',
    ok: otherActive === null,
    detail: otherActive ? `Transizione ${otherActive.kind} attiva dal ${otherActive.started_at.toISOString()}: va conclusa o annullata` : null,
    reason: 'TRANSITION_ACTIVE',
  });

  // Mode postgres e identità del volume verificata su Radicale.
  let identityOk = false;
  let identityDetail: string | null = null;
  let identityReason: PreconditionReason = 'IDENTITY_NOT_OK';
  if (state.mode !== 'postgres') {
    identityDetail = `Il backend è in mode ${state.mode}: il passaggio parte solo da postgres`;
    identityReason = 'MODE_NOT_POSTGRES';
  } else {
    try {
      await deps.assertWritable(db);
      identityOk = true;
      identityDetail = `Volume ${state.volume_id ?? '-'} con epoch ${state.epoch} verificato su Radicale`;
    } catch (err) {
      if (err instanceof MigrationError) {
        identityDetail = err.message;
        const reasons = Array.isArray(err.details?.reasons) ? (err.details?.reasons as string[]) : [];
        if (reasons.includes('MODE_NOT_POSTGRES')) identityReason = 'MODE_NOT_POSTGRES';
      } else {
        identityDetail = `Identità non verificabile (${describeRadicaleError(err)})`;
      }
    }
  }
  out.push({ id: 'identity_ok', label: 'Mode postgres e identità del volume di Radicale verificata', ok: identityOk, detail: identityDetail, reason: identityReason });

  // Ultima verifica completa accettabile e successiva all'ultimo apply che ha scritto.
  const [verify, writingApply] = await Promise.all([
    latestVerifyVerdicts(db).catch((err: unknown) => {
      log.warn({ err: err instanceof Error ? err.message : String(err) }, 'verdetti dell\'ultima verifica non letti');
      return { runId: null, verdicts: [], acceptable: false, finished_at: null as Date | null };
    }),
    lastWritingApplyAt(db),
  ]);
  let verifyOk = false;
  let verifyDetail: string;
  let verifyReason: PreconditionReason = 'VERIFY_REQUIRED';
  if (!verify.runId || !verify.finished_at) {
    verifyDetail = 'Nessuna verifica completa (V1-V5 su tutti i calendari) riuscita';
  } else if (writingApply && verify.finished_at.getTime() <= writingApply.getTime()) {
    verifyDetail = 'L\'ultima verifica completa è precedente all\'ultimo apply che ha scritto: ripeti la verifica';
  } else if (opts.verifyRunId && opts.verifyRunId !== verify.runId.toLowerCase()) {
    verifyDetail = 'La verifica vista nel wizard non è più l\'ultima: ricarica il passo e controlla la verifica nuova';
  } else if (!verify.acceptable) {
    const red = verify.verdicts.filter((v) => v.color === 'red').length;
    const yellow = verify.verdicts.filter((v) => v.color === 'yellow' && !v.accepted).length;
    verifyDetail = [red ? plural(red, 'calendario rosso', 'calendari rossi') : null, yellow ? plural(yellow, 'calendario giallo da accettare', 'calendari gialli da accettare') : null]
      .filter(Boolean).join(', ') || 'Verifica non accettabile';
    verifyReason = 'VERIFY_RED';
  } else {
    verifyOk = true;
    const yellow = verify.verdicts.filter((v) => v.color === 'yellow').length;
    verifyDetail = `Verifica del ${verify.finished_at.toISOString()}: ${yellow ? `verde o gialla accettata (${yellow} gialli)` : 'tutti i calendari verdi'}`;
  }
  out.push({ id: 'verify_acceptable', label: 'Verifica V1-V5: tutti i calendari verdi o gialli accettati, dopo l\'ultimo apply', ok: verifyOk, detail: verifyDetail, reason: verifyReason });

  // Parità dello shadow: 7 giorni, oppure (nuovo cutover dopo un rollback) una verifica accettabile dopo il rollback.
  let parity: ParityView | null = null;
  try {
    parity = await getParity(db, now);
  } catch (err) {
    log.warn({ err: err instanceof Error ? err.message : String(err) }, 'parità dello shadow non letta');
  }
  const lastRollback = await getLatestTransition(db, 'rollback');
  let parityOk: boolean;
  let parityDetail: string;
  if (lastRollback && lastRollback.status === 'completed' && lastRollback.finished_at) {
    const after = verify.finished_at && verify.acceptable && verify.finished_at.getTime() > lastRollback.finished_at.getTime();
    parityOk = Boolean(after);
    parityDetail = after
      ? `Nuovo passaggio dopo il rollback del ${lastRollback.finished_at.toISOString()}: verifica accettabile successiva`
      : `Dopo il rollback del ${lastRollback.finished_at.toISOString()} serve una verifica completa accettabile`;
  } else {
    parityOk = parity?.satisfied === true;
    parityDetail = parity
      ? `${parity.days_green}/${parity.required_days} giorni di parità verde${parity.shadow_enabled ? '' : ' (shadow spento)'}`
      : 'Parità dello shadow non disponibile';
  }
  out.push({ id: 'shadow_parity', label: `Shadow con parità verde da almeno ${MIGRATION_LIMITS.parityDaysRequired} giorni`, ok: parityOk, detail: parityDetail, reason: 'SHADOW_PARITY_REQUIRED' });

  // Matrice device.
  const matrix = state.migration_declarations.device_matrix;
  out.push({
    id: 'device_matrix',
    label: 'Matrice device superata (iOS, macOS, DAVx5, Thunderbird) e registrata',
    ok: matrix?.value.result === 'passed',
    detail: matrix ? `Esito ${matrix.value.result === 'passed' ? 'superato' : 'negativo'} registrato il ${matrix.at}` : 'Esito della matrice non registrato',
    reason: 'DEVICE_MATRIX_REQUIRED',
  });

  // Backup coordinato: quello del cutover (meno di 2 ore, identità corrente) e quello della F3 (informativo).
  const b = state.last_stack_backup;
  const backupAge = b && typeof b.at === 'string' ? now.getTime() - Date.parse(b.at) : Number.NaN;
  const sameIdentity = !!b && b.volume_id !== null && state.volume_id !== null && b.volume_id.toLowerCase() === state.volume_id.toLowerCase()
    && (b.epoch === null || b.epoch === state.epoch);
  const fresh = !!b && b.complete && Number.isFinite(backupAge) && backupAge >= 0 && backupAge < F4_LIMITS.cutoverBackupMaxAgeMinutes * MINUTE_MS && sameIdentity;
  out.push({
    id: 'backup_fresh',
    label: `Backup coordinato (database e volume) di meno di ${F4_LIMITS.cutoverBackupMaxAgeMinutes / 60} ore con l'identità corrente`,
    ok: fresh,
    detail: !b
      ? 'Nessun backup coordinato registrato'
      : !b.complete
        ? `Ultimo backup coordinato del ${b.at} incompleto`
        : !sameIdentity
          ? `Ultimo backup coordinato del ${b.at} con un'identità del volume diversa da quella corrente`
          : fresh
            ? `Backup coordinato del ${b.at}`
            : `Ultimo backup coordinato del ${b.at}: più vecchio di ${F4_LIMITS.cutoverBackupMaxAgeMinutes / 60} ore`,
    reason: 'BACKUP_TOO_OLD',
  });
  const declared = state.migration_declarations.backup_verified;
  const recent = (!!b && b.complete && Number.isFinite(backupAge) && backupAge >= 0 && backupAge < MIGRATION_LIMITS.backupMaxAgeHours * HOUR_MS)
    || (!!declared && now.getTime() - Date.parse(declared.at) < MIGRATION_LIMITS.backupDeclarationValidHours * HOUR_MS);
  out.push({
    id: 'backup_recent',
    label: `Backup di meno di ${MIGRATION_LIMITS.backupMaxAgeHours} ore (informativo: per il passaggio vale il backup coordinato di 2 ore)`,
    ok: recent,
    detail: recent ? null : 'Nessun backup recente',
    reason: null,
  });

  // Conflitti aperti e intenti pendenti; righe da rivalidare.
  const [ledger] = await db<Array<{ pending_intents: number; revalidation: number }>>`
    SELECT count(*) FILTER (WHERE deleted_at IS NULL AND intent_op IS NOT NULL)::int AS pending_intents,
           count(*) FILTER (WHERE deleted_at IS NULL AND revalidate_reason IS NOT NULL)::int AS revalidation
    FROM cal_migration_ledger
  `;
  const openConflicts = parity ? parity.open_conflicts : await countOpenShadowConflicts(db);
  const pendingIntents = Number(ledger?.pending_intents ?? 0);
  out.push({
    id: 'no_open_conflicts',
    label: 'Nessun conflitto aperto (apply e shadow) e nessun intento pendente nel ledger',
    ok: openConflicts === 0 && pendingIntents === 0,
    detail: openConflicts || pendingIntents
      ? [openConflicts ? plural(openConflicts, 'conflitto aperto', 'conflitti aperti') : null, pendingIntents ? plural(pendingIntents, 'intento pendente', 'intenti pendenti') : null].filter(Boolean).join(', ')
      : null,
    reason: 'OPEN_CONFLICTS',
  });
  const revalidation = Number(ledger?.revalidation ?? 0);
  out.push({
    id: 'no_revalidation',
    label: 'Nessuna riga del ledger da rivalidare',
    ok: revalidation === 0,
    detail: revalidation ? `${plural(revalidation, 'riga', 'righe')} da rivalidare: esegui un apply con "forza" REVALIDATION_REQUIRED` : null,
    reason: 'REVALIDATION_PENDING',
  });

  // Control-plane e probe (servono alla quiescenza).
  const cp = deps.controlPlaneStatus();
  const cpOk = !!cp && cp.running && cp.lastTick?.ok === true;
  out.push({
    id: 'control_plane',
    label: 'Control-plane del calendario attivo nel processo, ultimo giro riuscito',
    ok: cpOk,
    detail: !cp || !cp.running
      ? 'Control-plane non attivo: policy e heartbeat non arriverebbero ai device'
      : cp.lastTick?.ok
        ? `Ultimo giro riuscito il ${cp.lastTick.finishedAt}`
        : `Ultimo giro non riuscito (${cp.lastTick?.failedStage ?? 'nessun giro'}; ${cp.consecutiveFailures} errori di fila)`,
    reason: 'CONTROL_PLANE_UNAVAILABLE',
  });
  const probe = deps.probeAvailable();
  out.push({
    id: 'probe',
    label: 'Password di caldes-probe disponibile (verifica della quiescenza dei device)',
    ok: probe,
    detail: probe ? null : 'RADICALE_PROBE_PASSWORD non impostata nell\'API',
    reason: 'PROBE_UNAVAILABLE',
  });

  // Archivio della Fase 0 in sola lettura per i device dopo il cutover (§3.5).
  const archives = await db<Array<{ collection_name: string | null }>>`
    SELECT collection_name FROM calendars WHERE origin = 'migration' AND lifecycle = 'active' ORDER BY collection_name
  `;
  let archiveOk = true;
  let archiveDetail: string | null = null;
  if (archives.length) {
    const policy = policyFromState({
      state: { ...state, mode: 'radicale', write_freeze: false },
      identity: 'ok',
      collections: await readSidecarCollections(db),
      principal: deps.principal(),
      now,
    });
    const writable = archives.map((a) => a.collection_name).filter((n): n is string => !!n && !policy.readonly.includes(n) && !policy.hidden.includes(n));
    archiveOk = writable.length === 0;
    archiveDetail = archiveOk
      ? `Archivio in sola lettura per i device anche in live (${archives.map((a) => a.collection_name).join(', ')})`
      : `Archivio scrivibile dai device dopo il passaggio: ${writable.join(', ')}`;
  } else {
    archiveDetail = 'Nessun archivio della Fase 0';
  }
  out.push({ id: 'archive_readonly', label: 'Archivio della Fase 0 assente, nascosto o in sola lettura per i device', ok: archiveOk, detail: archiveDetail, reason: 'ARCHIVE_DEVICE_WRITABLE' });

  // Immagine dell'API fissata su una versione (OPS-1): un rollback d'immagine sotto la F4 durante la finestra di rollback
  // non è fermato da nulla (le immagini F1-F3 scrivono heartbeat e policy live), quindi in produzione il cutover parte
  // solo con l'API su sha-<short> e il runbook vieta di scendere sotto la release F4.
  const apiVersion = deps.apiVersion();
  const unversioned = process.env.NODE_ENV === 'production' && apiVersion === 'unversioned';
  out.push({
    id: 'api_image_pinned',
    label: 'Immagine dell\'API fissata su una versione (sha-<short>)',
    ok: !unversioned,
    detail: unversioned
      ? 'API senza versione (CALDES_API_VERSION o GIT_COMMIT_SHA assenti): fissa il compose dell\'API su sha-<short> prima del passaggio'
      : `Versione dell'API: ${apiVersion}`,
    reason: 'API_IMAGE_UNVERSIONED',
  });

  return out;
}

function publicCriteria(list: readonly CriterionEval[]): CutoverCriterion[] {
  return list.map(({ reason: _reason, ...c }) => c);
}

/**
 * Criteri del cutover (contratto §3.2), per il wizard, la route e il passo di
 * preflight. Sola lettura (nessun giro del control-plane: vale l'ultimo).
 * `transitionId`: la transizione che si sta riprendendo non conta come
 * "un'altra transizione attiva".
 */
export async function cutoverCriteria(
  db: Db,
  opts: { now?: Date; verifyRunId?: string | null; transitionId?: string | null; deps?: Partial<CutoverCriteriaDeps> } = {},
): Promise<CutoverCriterion[]> {
  const deps = { ...defaultCutoverCriteriaDeps(), ...(opts.deps ?? {}) };
  return publicCriteria(await evaluateCriteria(db, { now: opts.now ?? new Date(), verifyRunId: opts.verifyRunId ?? null, transitionId: opts.transitionId ?? null, deps }));
}

/**
 * Come cutoverCriteria, ma lancia PRECONDITION_FAILED con details.reasons
 * (PreconditionReason) e details.criteria se un criterio bloccante non è
 * soddisfatto (backup_recent è solo informativo).
 */
export async function assertCutoverReady(
  db: Db,
  opts: { now?: Date; verifyRunId?: string | null; transitionId?: string | null; deps?: Partial<CutoverCriteriaDeps> } = {},
): Promise<CutoverCriterion[]> {
  const deps = { ...defaultCutoverCriteriaDeps(), ...(opts.deps ?? {}) };
  const list = await evaluateCriteria(db, { now: opts.now ?? new Date(), verifyRunId: opts.verifyRunId ?? null, transitionId: opts.transitionId ?? null, deps });
  const failing = list.filter((c) => !c.ok && c.reason !== null);
  if (failing.length) {
    const reasons = [...new Set(failing.map((c) => c.reason as PreconditionReason))];
    throw preconditionError(
      `Passaggio non ancora possibile: ${failing.map((c) => c.detail ?? c.label).join('; ')}`,
      reasons,
      'PRECONDITION_FAILED',
      { criteria: publicCriteria(list) },
    );
  }
  return publicCriteria(list);
}

// ─── Prenotazioni a cavallo del freeze ───────────────────────────────

/**
 * Accoda project_booking per le prenotazioni create o cambiate da `since`
 * (contratto §3.1, passo bookings_reconcile): una prenotazione committata
 * dopo la fotografia del delta (proiezione legacy rifiutata dalla guardia 166
 * o accodata in mode cutover) ottiene la propria risorsa booking-<uid>.ics
 * quando il job gira, dopo il run. Idempotente: il job converge allo stato
 * corrente della prenotazione. Restituisce quante prenotazioni ha accodato.
 */
export async function reconcileBookingsAfterCutover(db: Db, since: Date): Promise<number> {
  const rows = await db<Array<{ uid: string; updated_at: Date | null }>>`
    SELECT uid, updated_at FROM calendar_bookings
    WHERE updated_at >= ${since} OR created_at >= ${since}
    ORDER BY created_at, uid
  `;
  for (const row of rows) {
    const version = row.updated_at instanceof Date ? row.updated_at.toISOString() : row.updated_at ? new Date(row.updated_at).toISOString() : null;
    await enqueueCalendarJob(CAL_JOB_KINDS.projectBooking, row.uid, {}, { db, sourceVersion: version });
  }
  return rows.length;
}

// ─── Dipendenze del run ───────────────────────────────

/** Ingressi esterni del run (sostituibili nei test). */
export interface CutoverDeps {
  criteria: Partial<CutoverCriteriaDeps>;
  /** Client caldes-svc e principal (RADICALE_NOT_CONFIGURED se assente). */
  radicale: () => { client: RadicaleClient; principal: string };
  /** Dipendenze della quiescenza (null: quelle di produzione di transition.ts). */
  quiescence: () => QuiescenceDeps | undefined;
  /** Giro del control-plane (null se il control-plane non è attivo nel processo). */
  controlPlaneSync: () => Promise<ControlPlaneTick | null>;
  /** Identità del volume riletta senza cache dopo il passo d'epoch. */
  verifyIdentity: () => Promise<IdentityCheck>;
  /** Sync di tutte le collezioni Radicale del sidecar. */
  syncAll: () => Promise<Array<SyncCollectionResult | CollectionSyncError>>;
  /** Prima passata completa della proiezione inversa. */
  reverse: (opts: { db: Db; actor: string; runId: string | null; signal?: AbortSignal }) => Promise<ReverseApplySummary & { hash: string }>;
  /** Smoke senza effetti collaterali. */
  smoke: (opts: { db: Db; signal?: AbortSignal }) => Promise<SmokeReport>;
  sleep: (ms: number) => Promise<void>;
  now: () => Date;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, Math.max(0, ms));
    t.unref?.();
  });
}

/** Dipendenze di produzione. */
export function defaultCutoverDeps(): CutoverDeps {
  return {
    criteria: {},
    radicale: requireRadicale,
    quiescence: () => undefined,
    controlPlaneSync: () => requestControlPlaneSync(),
    verifyIdentity: async () => (await verifyVolumeIdentity({ force: true })).check,
    syncAll: () => syncAllCollections({ reason: 'manual', actor: 'system:cutover' }),
    // Import differito: il proiettore inverso (gruppo REVERSE) si carica solo quando il passo gira.
    reverse: async (opts) => {
      const { runReverseProjection } = await import('./reverse-projector');
      return runReverseProjection({ db: opts.db, actor: opts.actor, runId: opts.runId, signal: opts.signal });
    },
    smoke: (opts) => runCutoverSmoke({ db: opts.db, signal: opts.signal }),
    sleep: defaultSleep,
    now: () => new Date(),
  };
}

// ─── Guardia d'identità durante la transizione ───────────────────────────────

/**
 * Guardia delle scritture e delle letture della fotografia in mode cutover
 * (al posto di assertMigrationWritable, che ammette solo postgres): stato
 * riletto senza cache nel mode atteso con l'epoch d'inizio della transizione,
 * identità `ok` letta da Radicale come caldes-svc.
 */
async function assertTransitionIdentity(db: Db, client: RadicaleClient, principal: string, handle: TransitionHandle, mode: BackendMode): Promise<MigrationBackendState> {
  const state = await readTransitionState(db);
  if (state.mode !== mode) {
    throw new TransitionError('PRECONDITION_FAILED', `Il backend è in mode ${state.mode} invece di ${mode}: la transizione è cambiata durante il passo.`, { runErrorCode: 'TRANSITION_CONFLICT' });
  }
  if (state.epoch !== handle.record.epoch_before) {
    throw new TransitionError('PRECONDITION_FAILED', `Epoch del volume cambiato durante la transizione (${handle.record.epoch_before} → ${state.epoch}).`, { runErrorCode: 'EPOCH_CONFLICT' });
  }
  const check = await checkVolumeIdentity(state, remoteIdentitySource(client, { timeoutMs: IDENTITY_TIMEOUT_MS }), principal);
  if (check.status !== 'ok') {
    throw new TransitionError('PRECONDITION_FAILED', `Identità del volume non verificata (${check.status}${check.detail ? `: ${check.detail}` : ''}): nessuna scrittura su Radicale.`, {
      runErrorCode: 'IDENTITY_NOT_OK', reasons: ['IDENTITY_NOT_OK'],
    });
  }
  return state;
}

// ─── Passo delta_apply ───────────────────────────────

/** Dati del passo delta_apply nel journal. */
export interface DeltaApplyData extends ApplySummary {
  /** Anomalie bloccanti del serializer (nessuna scrittura fatta se presenti). */
  blocking: string[];
  scope: MigrationScope;
  plan_run_id: string | null;
  attempt: number;
  [key: string]: unknown;
}

function deltaConflicts(data: Pick<ApplySummary, 'conflicts'>): number {
  return Object.values(data.conflicts ?? {}).reduce((a: number, n) => a + (typeof n === 'number' ? n : 0), 0);
}

/**
 * Apply completo del delta (design §13.10 passo 3): stesse regole di runApply
 * (prima tutto tranne le cancellazioni, per collezione; poi le cancellazioni,
 * con quelle degli spostamenti dopo la scrittura nella nuova collezione),
 * nessuna forzatura, nessun confronto dell'hash dell'anteprima. Le righe
 * 'object' vanno nel run del cutover.
 */
async function runDeltaApply(ctx: MigrationRunContext<unknown>, handle: TransitionHandle, deps: CutoverDeps, attempt: number): Promise<DeltaApplyData> {
  const started = Date.now();
  const { client, principal } = deps.radicale();
  await assertTransitionIdentity(ctx.db, client, principal, handle, 'cutover');
  const reference = await referencePlan(ctx.db);
  const now = deps.now();
  await ctx.progress({ phase: 'delta_apply', message: 'Delta: ricalcolo del piano con le opzioni dell\'ultima anteprima' });
  const plan = await buildPlan({ db: ctx.db, client, principal, mode: 'apply', scope: reference.scope, options: reference.options, now, signal: ctx.signal });
  ctx.throwIfCancelled();
  const blocking = [...new Set(plan.serialization.anomalies.filter((a) => ANOMALY_DEFINITIONS[a.code].blocking).map((a) => a.code))].sort();
  const totals = emptyOutcomeCounts();
  const writes = { create: 0, update: 0, delete: 0 };
  const conflicts: ApplySummary['conflicts'] = {};
  const base = {
    plan_hash: plan.hash,
    expected_plan_hash: null,
    scope: reference.scope,
    plan_run_id: reference.runId,
    attempt,
  };
  if (blocking.length) {
    return { ...base, totals, writes, conflicts, failed: 0, adopted: 0, forced: 0, duration_ms: Date.now() - started, zero_writes: false, blocking };
  }

  const execCtx: ExecuteContext = {
    db: ctx.db,
    client,
    principal,
    runId: ctx.runId,
    actor: ctx.actor,
    mode: 'apply',
    forced: false,
    signal: ctx.signal,
    throttle: migrationThrottle(),
    now: () => new Date(),
  };
  const groups = (items: PlanItem[]): PlanItem[][] => {
    const map = new Map<string, PlanItem[]>();
    for (const item of items) {
      const k = `${item.collection_name}|${item.calendar_id}`;
      const list = map.get(k) ?? [];
      list.push(item);
      map.set(k, list);
    }
    return [...map.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([, list]) => list);
  };
  const phases = [groups(plan.items.filter((i) => i.action !== 'delete')), groups(plan.items.filter((i) => i.action === 'delete'))];
  const movedSourceOutcome = new Map<string, ApplyOutcome>();
  const keysWithSource = new Set(plan.items.filter((i) => i.source).map((i) => i.legacy_key));
  let plannedWrites = 0;
  let pending: MigrationItemInput[] = [];
  let done = 0;
  const flush = async (): Promise<void> => {
    while (pending.length) {
      const chunk = pending.slice(0, ROWS_CHUNK);
      await ctx.addItems(chunk);
      pending = pending.slice(chunk.length);
    }
  };
  const record = (item: PlanItem, executed: ExecutedItem): void => {
    totals[executed.outcome] += 1;
    if (isWriteAction(item.action)) plannedWrites += 1;
    if ((executed.outcome === 'done' || executed.outcome === 'forced') && isWriteAction(item.action)) {
      writes[item.action as 'create' | 'update' | 'delete'] += 1;
    }
    if (executed.outcome === 'conflict' && executed.code && CONFLICT_SET.has(executed.code)) {
      const c = executed.code as ConflictCode;
      conflicts[c] = (conflicts[c] ?? 0) + 1;
    }
    if (item.source) movedSourceOutcome.set(item.legacy_key, executed.outcome);
    pending.push(applyItemRow(item, executed, attempt));
  };
  try {
    for (const phase of phases) {
      for (const group of phase) {
        ctx.throwIfCancelled();
        // Identità e mode riletti prima di ogni collezione (come la guardia dell'apply della F3).
        await assertTransitionIdentity(ctx.db, client, principal, handle, 'cutover');
        for (const item of group) {
          ctx.throwIfCancelled();
          let executed: ExecutedItem;
          if (item.action === 'delete' && !item.source && keysWithSource.has(item.legacy_key)) {
            const created = movedSourceOutcome.get(item.legacy_key);
            executed = created === 'done' || created === 'forced' || created === 'adopted' || created === 'noop'
              ? await executePlanItem(item, execCtx)
              : { outcome: 'skipped', code: item.code as ExecutedItem['code'], etag_after: null, http_status: null, error: 'spostamento non completato: la cancellazione nella collezione di origine attende la scrittura nella nuova', fields: item.fields };
          } else {
            executed = await executePlanItem(item, execCtx);
          }
          record(item, executed);
          done += 1;
          if (pending.length >= ROWS_FLUSH_EVERY) await flush();
          await ctx.progress({ phase: 'delta_apply', done, total: plan.items.length, calendar_id: item.calendar_id, message: `Delta: ${item.action === 'delete' ? 'cancellazioni' : 'scritture'} in ${item.collection_name || 'collezione'}` });
        }
      }
    }
  } finally {
    await flush().catch((err: unknown) => log.error({ err: err instanceof Error ? err.message : String(err) }, 'righe del delta non salvate'));
  }
  const writesDone = writes.create + writes.update + writes.delete;
  const conflictCount = deltaConflicts({ conflicts });
  return {
    ...base,
    totals,
    writes,
    conflicts,
    failed: totals.failed,
    adopted: totals.adopted,
    forced: totals.forced,
    duration_ms: Date.now() - started,
    zero_writes: writesDone === 0 && plannedWrites === 0 && conflictCount === 0 && totals.failed === 0,
    blocking,
  };
}

/** Motivo d'annullamento dopo il delta (null se il delta è pulito). */
function deltaAbortReason(data: DeltaApplyData): string | null {
  const parts: string[] = [];
  if (data.blocking?.length) parts.push(`anomalie bloccanti in PG (${data.blocking.join(', ')})`);
  const conflicts = deltaConflicts(data);
  if (conflicts) parts.push(plural(conflicts, 'conflitto', 'conflitti'));
  if (data.failed) parts.push(plural(data.failed, 'scrittura fallita', 'scritture fallite'));
  return parts.length ? `delta del cutover non pulito: ${parts.join(', ')}` : null;
}

// ─── Passo delta_verify ───────────────────────────────

/** Dati del passo delta_verify nel journal. */
type DeltaVerifyData = VerifySummary & { run_id: string; [key: string]: unknown };

async function runDeltaVerify(ctx: MigrationRunContext<unknown>, handle: TransitionHandle): Promise<DeltaVerifyData> {
  // Righe 'diff' di un tentativo precedente di questo stesso run (crash a metà): si rifanno da capo.
  await ctx.db`DELETE FROM cal_migration_items WHERE run_id = ${ctx.runId}::uuid AND item_type = 'diff'`;
  const params: VerifyParams = { scope: {}, levels: [...DELTA_VERIFY_LEVELS], v4_days: DELTA_VERIFY_V4_DAYS };
  const verifyCtx = { ...(ctx as MigrationRunContext<unknown>), params } as MigrationRunContext<VerifyParams>;
  const summary = await runVerifyWithGuard(verifyCtx, async ({ client, principal }) => {
    await assertTransitionIdentity(ctx.db, client, principal, handle, 'cutover');
  });
  return { ...summary, run_id: ctx.runId } as DeltaVerifyData;
}

function verifyAbortReason(data: VerifySummary): string | null {
  if (data.acceptable) return null;
  const red = data.calendars.filter((c) => c.color === 'red');
  const yellow = data.calendars.filter((c) => c.color === 'yellow' && !c.accepted);
  const parts: string[] = [];
  if (red.length) parts.push(`${plural(red.length, 'calendario rosso', 'calendari rossi')} (${red.map((c) => c.slug || c.collection_name).join(', ')})`);
  if (yellow.length) parts.push(`${plural(yellow.length, 'calendario giallo', 'calendari gialli')} con differenze nuove non accettate (${yellow.map((c) => c.slug || c.collection_name).join(', ')})`);
  return `verifica del delta non accettabile: ${parts.join('; ') || `colore ${data.overall}`}`;
}

// ─── Passo control_plane ───────────────────────────────

async function runControlPlaneStep(handle: TransitionHandle, deps: CutoverDeps): Promise<Record<string, unknown>> {
  const E1 = handle.record.epoch_before + 1;
  let last: string = 'nessun giro';
  for (let attempt = 1; attempt <= CONTROL_PLANE_ATTEMPTS; attempt++) {
    const tick = await deps.controlPlaneSync();
    if (!tick) {
      throw new TransitionError('PRECONDITION_FAILED', 'Control-plane non attivo nel processo: policy e heartbeat con il nuovo epoch non scritti. Riavvia l\'API con il control-plane e riprendi il passaggio.', {
        runErrorCode: 'CONTROL_PLANE_UNAVAILABLE', reasons: ['CONTROL_PLANE_UNAVAILABLE'],
      });
    }
    const aligned = tick.ok && tick.state?.mode === 'radicale' && tick.state.epoch === E1 && tick.policy?.mode === 'frozen' && tick.heartbeat !== null;
    if (aligned) {
      const identity = await deps.verifyIdentity();
      if (identity.status === 'ok') {
        return {
          policy: { mode: tick.policy?.mode ?? null, version: tick.policy?.version ?? null, reasons: [...(tick.policy?.reasons ?? [])] },
          heartbeat: { ts: tick.heartbeat?.ts ?? null, mode: tick.state?.mode ?? null, epoch: tick.state?.epoch ?? null },
          identity: { status: identity.status, checked_at: identity.checkedAt, marker_epoch: identity.marker?.epoch ?? null },
          attempts: attempt,
        };
      }
      last = `identità ${identity.status}${identity.detail ? ` (${identity.detail})` : ''}`;
    } else {
      last = tick.ok
        ? `policy ${tick.policy?.mode ?? '-'} per mode ${tick.state?.mode ?? '-'} ed epoch ${tick.state?.epoch ?? '-'}`
        : `giro fallito (${tick.failedStage ?? 'sconosciuto'})`;
    }
    if (attempt < CONTROL_PLANE_ATTEMPTS) await deps.sleep(CONTROL_PLANE_RETRY_MS);
  }
  throw new TransitionError('CALENDAR_UNAVAILABLE', `Policy e heartbeat non allineati al nuovo epoch ${E1}: ${last}. I device restano chiusi; riprendi il passaggio.`, {
    runErrorCode: 'CONTROL_PLANE_UNAVAILABLE',
  });
}

// ─── Passo index_sync ───────────────────────────────

async function runIndexSyncStep(db: Db, deps: CutoverDeps): Promise<Record<string, unknown>> {
  // Validatori del pull legacy delle iscrizioni (anomalia ICS_PULL_REFETCH della F3): il pull verso l'indice rilegge tutto.
  const reset = await db`
    UPDATE calendar_subscriptions SET etag = NULL, last_modified = NULL
    WHERE etag IS NOT NULL OR last_modified IS NOT NULL
    RETURNING id
  `;
  const results = await deps.syncAll();
  const failed = results.filter((r): r is CollectionSyncError => r instanceof CollectionSyncError);
  const ok = results.filter((r): r is SyncCollectionResult => !(r instanceof CollectionSyncError));
  // Collezioni non sincronizzate (una che non sincronizza in modo persistente non deve bloccare il cutover oltre il punto
  // di non ritorno: non c'è via d'uscita): la sync periodica le riprova; busy e prenotazioni sono già fail-closed sulla
  // freshness. Se syncAll() stesso lancia (Radicale irraggiungibile) il passo fallisce e la ripresa basta.
  if (failed.length) log.error({ failed: failed.map((f) => ({ calendar_id: f.calendarId, code: f.code })) }, 'sync del cutover: collezioni non sincronizzate, la sync periodica le riprova');
  const held = ok.filter((r) => r.status === 'held').map((r) => r.calendarId);
  if (held.length) log.warn({ held }, 'sync del cutover: collezioni con cancellazioni sospese (da risolvere dall\'admin)');
  return {
    subscriptions_reset: reset.length,
    collections: results.length,
    synced: ok.filter((r) => r.status === 'synced').length,
    unchanged: ok.filter((r) => r.status === 'unchanged').length,
    skipped: ok.filter((r) => r.status === 'skipped').length,
    held,
    upserted: ok.reduce((a, r) => a + r.upserted, 0),
    deleted: ok.reduce((a, r) => a + r.deleted, 0),
    quarantined: ok.reduce((a, r) => a + r.quarantined, 0),
    failed: failed.map((f) => ({ calendar_id: f.calendarId, code: f.code })),
    degraded: failed.length > 0,
  };
}

// ─── Riassunto ───────────────────────────────

async function buildSummary(handle: TransitionHandle, outcome: 'completed' | 'aborted', abortReason: string | null): Promise<CutoverSummary> {
  const db = handle.ctx.db;
  const journal = await readJournal(db, handle.record.id);
  const data = (step: string): Record<string, unknown> | null => {
    const j = journal.find((s) => s.step === step && (s.status === 'done' || s.status === 'skipped'));
    return j ? j.data : null;
  };
  const state = await readTransitionState(db);
  const delta = data('delta_apply');
  const verify = data('delta_verify');
  const bookings = data('bookings_reconcile');
  return {
    transition_id: handle.record.id,
    outcome,
    abort_reason: abortReason,
    epoch_before: handle.record.epoch_before,
    epoch_after: handle.record.epoch_after,
    rollback_until: outcome === 'completed' ? iso(state.rollback_until) : null,
    quiescence: (data('quiesce') as unknown as QuiescenceReport | null) ?? null,
    delta: (delta as unknown as ApplySummary | null) ?? null,
    verify: (verify as unknown as VerifySummary | null) ?? null,
    reverse: data('reverse_start')?.skipped ? null : ((data('reverse_start') as unknown as ReverseApplySummary | null) ?? null),
    bookings_reconciled: typeof bookings?.enqueued === 'number' ? bookings.enqueued : 0,
    smoke: (data('smoke') as unknown as SmokeReport | null) ?? null,
    steps: await journalViews(handle),
  };
}

/** Annulla il cutover prima del passo d'epoch e fa fallire il run con CUTOVER_ABORTED e il riassunto. */
async function abortCutover(handle: TransitionHandle, code: string, reason: string): Promise<never> {
  await abortTransition(handle, { code, reason });
  const summary = await buildSummary(handle, 'aborted', reason);
  log.warn({ transitionId: handle.record.id, code, reason }, 'cutover annullato: backend di nuovo in mode postgres con la policy shadow');
  throw new TransitionError('PRECONDITION_FAILED', `Passaggio annullato, Postgres resta autorevole: ${reason}.`, {
    runErrorCode: 'CUTOVER_ABORTED',
    details: { transition_id: handle.record.id, abort_code: code, summary },
  });
}

// ─── Run `cutover` ───────────────────────────────

/** Run `cutover` (contratto §3.1): avvio, ripresa o annullamento della transizione. */
export async function runCutover(ctx: MigrationRunContext<CutoverParams>): Promise<CutoverSummary> {
  return runCutoverWith(ctx, defaultCutoverDeps());
}

/** Come runCutover con le dipendenze esplicite (test). */
export async function runCutoverWith(ctx: MigrationRunContext<CutoverParams>, depsIn: Partial<CutoverDeps> = {}): Promise<CutoverSummary> {
  const deps: CutoverDeps = { ...defaultCutoverDeps(), ...depsIn };
  const params = normalizeCutoverParams(ctx.params);
  const tctx: TransitionContext = { ...transitionContextFromRun(ctx as MigrationRunContext<unknown>), now: deps.now };

  // Stesso run ripreso dall'esecutore (lease scaduto) dopo che la transizione si era già conclusa:
  // l'esito è quello registrato, senza rieseguire nulla.
  const latest = await getLatestTransition(ctx.db, 'cutover');
  if (latest && latest.status !== 'active' && latest.run_id === ctx.runId) {
    const done: TransitionHandle = { ctx: tctx, record: latest };
    if (latest.status === 'completed') return buildSummary(done, 'completed', null);
    const summary = await buildSummary(done, 'aborted', latest.outcome);
    if (params.action === 'abort') return summary;
    throw new TransitionError('PRECONDITION_FAILED', `Passaggio annullato, Postgres resta autorevole: ${latest.outcome ?? 'annullato'}.`, {
      runErrorCode: 'CUTOVER_ABORTED',
      details: { transition_id: latest.id, abort_code: latest.outcome_code, summary },
    });
  }

  if (params.action === 'abort') {
    const { handle } = await beginTransition({ ctx: tctx, kind: 'cutover', resume: true });
    const reason = 'annullato dall\'admin';
    // Il marker serve solo se il passo d'epoch è già stato tentato; con Radicale non configurato l'annullamento prima dell'epoch resta possibile.
    let marker: { client: RadicaleClient; principal: string } | undefined;
    try {
      marker = deps.radicale();
    } catch {
      marker = undefined;
    }
    await abortTransition(handle, { code: 'CUTOVER_ABORTED', reason, marker });
    log.warn({ transitionId: handle.record.id, actor: ctx.actor }, 'cutover annullato dall\'admin: backend in mode postgres con la policy shadow');
    return buildSummary(handle, 'aborted', reason);
  }

  const { handle, resumed } = await beginTransition({
    ctx: tctx,
    kind: 'cutover',
    resume: params.action === 'resume',
    data: { rollback_window_days: params.rollback_window_days, verify_run_id: params.verify_run_id, api_version: resolveApiVersion() },
  });
  const journalAtStart = await readJournal(ctx.db, handle.record.id);
  if (resumed && params.action === 'start' && !pastPointOfNoReturn(journalAtStart)) {
    // Nuovo avvio confermato su una transizione ferma prima del punto di non ritorno: valgono i parametri nuovi.
    await mergeTransitionData(handle, { rollback_window_days: params.rollback_window_days, verify_run_id: params.verify_run_id });
  }
  const windowDays = validWindowDays(handle.record.data.rollback_window_days) ?? params.rollback_window_days;
  const verifyRunId = typeof handle.record.data.verify_run_id === 'string' ? handle.record.data.verify_run_id : params.verify_run_id;
  const total = CUTOVER_STEPS.length;
  const progress = (index: number, message: string): Promise<void> => ctx.progress({ phase: CUTOVER_STEPS[index], done: index, total, message });
  if (resumed) log.info({ transitionId: handle.record.id, runId: ctx.runId, attempt: ctx.attempt }, 'ripresa del cutover dal primo passo non concluso');

  // 1. Preflight.
  await progress(0, 'Controllo dei criteri del passaggio');
  const preflightDoneBefore = (await completedStep(handle, 'preflight')) !== null;
  await runStep(handle, 'preflight', async () => {
    // Giro del control-plane: il criterio guarda l'esito dell'ultimo giro.
    await deps.controlPlaneSync().catch(() => null);
    const criteria = await assertCutoverReady(ctx.db, { now: deps.now(), verifyRunId, transitionId: handle.record.id, deps: deps.criteria });
    return { criteria, rollback_window_days: windowDays, verify_run_id: verifyRunId };
  });
  if (preflightDoneBefore && !(await completedStep(handle, 'freeze'))) {
    // Ripresa prima del freeze: i criteri si ricontrollano adesso (il backup può essere invecchiato).
    await deps.controlPlaneSync().catch(() => null);
    await assertCutoverReady(ctx.db, { now: deps.now(), verifyRunId, transitionId: handle.record.id, deps: deps.criteria });
  }

  // 2. Freeze: prima lo stato, poi la policy frozen.
  await progress(1, 'Scritture sospese: mode cutover, device in sola lettura');
  await freezeStep(handle);

  // 3. Gate esclusivo e quiescenza dei device.
  await progress(2, 'Attesa delle scritture in corso e quiescenza dei device');
  await quiesceStep(handle, (await completedStep(handle, 'quiesce')) ? undefined : deps.quiescence());

  // 4. Apply del delta.
  await progress(3, 'Delta: ultime modifiche di Postgres verso Radicale');
  const delta = await runStep(handle, 'delta_apply', async ({ attempt }) => runDeltaApply(ctx as MigrationRunContext<unknown>, handle, deps, attempt));
  const deltaReason = deltaAbortReason(delta as DeltaApplyData);
  if (deltaReason) await abortCutover(handle, 'CUTOVER_ABORTED', deltaReason);

  // 5. Verifica del delta.
  await progress(4, 'Verifica V1, V2 e V4 dopo il delta');
  const verify = await runStep(handle, 'delta_verify', async () => runDeltaVerify(ctx as MigrationRunContext<unknown>, handle));
  const verifyReason = verifyAbortReason(verify as unknown as VerifySummary);
  if (verifyReason) await abortCutover(handle, 'VERIFY_RED', verifyReason);

  // 6. Epoch: punto di non ritorno.
  await progress(5, 'Cambio di epoch: Radicale diventa la fonte del calendario');
  const { client, principal } = deps.radicale();
  const epochAt = deps.now();
  await epochStep(handle, { client, principal }, {
    set: {
      rollback_until: new Date(epochAt.getTime() + windowDays * DAY_MS),
      cutover_at: epochAt,
      cutover_by: ctx.actor,
      api_min_version: CALENDAR_API_LEVEL,
    },
  });

  // 7. Policy e heartbeat con il nuovo epoch.
  await progress(6, 'Policy dei device e heartbeat con il nuovo epoch');
  await runStep(handle, 'control_plane', async () => runControlPlaneStep(handle, deps));

  // 8. Indice.
  await progress(7, 'Sync completa dell\'indice');
  await runStep(handle, 'index_sync', async () => runIndexSyncStep(ctx.db, deps));

  // 9. Proiezione inversa.
  await progress(8, 'Prima passata della proiezione inversa verso Postgres');
  await runStep(handle, 'reverse_start', async () => {
    try {
      const summary = await deps.reverse({ db: ctx.db, actor: ctx.actor, runId: ctx.runId, signal: ctx.signal });
      if (summary.failed > 0) log.warn({ failed: summary.failed }, 'proiezione inversa con REVERSE_FAILED: compaiono nella salute e nell\'anteprima del rollback');
      return summary as unknown as Record<string, unknown>;
    } catch (err) {
      // Dopo il punto di non ritorno un errore persistente della prima passata non deve bloccare il passaggio: lo sweep
      // periodico della proiezione inversa riprova (e compare nella salute).
      if (ctx.signal?.aborted) throw err;
      const message = err instanceof Error ? err.message : String(err);
      log.error({ err: message }, 'proiezione inversa: prima passata non riuscita, la riprova lo sweep periodico');
      return { skipped: true, error_code: 'REVERSE_START_FAILED', message: message.slice(0, 500) };
    }
  });

  // 10. Prenotazioni a cavallo del freeze.
  await progress(9, 'Proiezioni delle prenotazioni a cavallo del passaggio');
  await runStep(handle, 'bookings_reconcile', async () => {
    const since = new Date(handle.record.started_at.getTime() - F4_LIMITS.bookingsReconcileMarginMs);
    const enqueued = await reconcileBookingsAfterCutover(ctx.db, since);
    return { since: since.toISOString(), enqueued };
  });

  // 11. Fine del freeze: policy live.
  await progress(10, 'Fine del freeze: i device tornano a scrivere');
  await stateStep(handle, 'unfreeze', { expectMode: 'radicale', set: { write_freeze: false } });

  // 12. Smoke.
  await progress(11, 'Smoke automatici senza effetti collaterali');
  const smoke = await runStep(handle, 'smoke', async () => {
    try {
      return (await deps.smoke({ db: ctx.db, signal: ctx.signal })) as unknown as Record<string, unknown>;
    } catch (err) {
      // runCutoverSmoke non lancia; una sostituzione che lancia vale come smoke non superato.
      log.error({ err: err instanceof Error ? err.message : String(err) }, 'smoke del cutover non eseguiti');
      const now = new Date().toISOString();
      return { ok: false, started_at: now, finished_at: now, checks: [] } satisfies SmokeReport as unknown as Record<string, unknown>;
    }
  }) as unknown as SmokeReport;

  await completeTransition(handle, {
    outcome: smoke.ok ? 'Passaggio a Radicale completato' : 'Passaggio a Radicale completato con smoke non superati: valuta il rollback',
  });
  await ctx.progress({ phase: 'done', done: total, total, message: smoke.ok ? 'Passaggio completato' : 'Passaggio completato, smoke non superati' });
  log.info({ transitionId: handle.record.id, epoch: handle.record.epoch_after, smoke: smoke.ok }, 'cutover completato: mode radicale, policy live');
  return buildSummary(handle, 'completed', null);
}
