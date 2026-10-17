/**
 * Finalize: chiusura della finestra di rollback (fase F4; design §13.13;
 * contratto docs/calendar-radicale/contracts/f4-modules.md §5.4). Run
 * `finalize` dello strumento di migrazione, avviato dal wizard con la
 * conferma digitata `CHIUDI LA FINESTRA` (la verifica la route).
 *
 * Passi (FINALIZE_STEPS, ognuno nel journal di transition.ts):
 *
 *  1. preflight       mode radicale, almeno 14 giorni dal cutover, salute del
 *                     calendario verde, nessun job morto, nessun
 *                     REVERSE_FAILED aperto, nessun'altra transizione;
 *  2. stop_reverse    job reverse_projection in coda chiusi (il run tiene
 *                     `cal-migration`: nessuno è in corso);
 *  3. state           mode `finalized`, finalized_at, rollback_until NULL. La
 *                     policy resta live e l'epoch non cambia (nessun cambio di
 *                     permessi: il finalize non si annulla);
 *  4. legacy_finalize calendar_finalize_legacy() (migrazione 167, release F7:
 *                     rename in calendar_events_legacy più vista) se esiste;
 *                     altrimenti passo saltato con la nota "si applica con la
 *                     release F7".
 *
 * Dopo il finalize la proiezione inversa non gira più (il job si chiude senza
 * azione fuori da mode radicale), la guardia 166 continua a rifiutare ogni
 * scrittura diretta su calendar_events e il rollback non è più disponibile:
 * Postgres resta una fotografia congelata fino alla F7.
 */

import type { Logger } from 'pino';
import { logger as rootLogger } from '../../logger';
import type { Db } from '../radicale/policy';
import { preconditionError } from './preflight';
import {
  beginTransition,
  completedStep,
  completeTransition,
  getActiveTransition,
  getLatestTransition,
  journalViews,
  readJournal,
  readTransitionState,
  runStep,
  skipStep,
  stateStep,
  type TransitionContext,
  transitionContextFromRun,
  type TransitionHandle,
} from './transition';
import {
  F4_LIMITS,
  FINALIZE_STEPS,
  type FinalizeParams,
  type FinalizeSummary,
  type MigrationBackendState,
  MigrationError,
  type MigrationRunContext,
  type PreconditionReason,
} from './types';

const log: Logger = rootLogger.child({ scope: 'calendar-finalize' });

const DAY_MS = 86_400_000;

/** Nota del passo legacy_finalize quando la funzione della 167 non esiste ancora. */
export const LEGACY_FINALIZE_PENDING_NOTE = 'si applica con la release F7 (migrazione 167: calendar_events_legacy e vista)';

// ─── Dipendenze ───────────────────────────────

/** Salute ridotta del calendario (stato e codici dei motivi, senza dettagli). */
export interface FinalizeHealth {
  status: 'ok' | 'degraded' | 'down';
  reasons: string[];
}

export interface FinalizeDeps {
  /** Salute del calendario (computeCalendarHealth della route di salute). */
  health: () => Promise<FinalizeHealth>;
  now: () => Date;
}

export function defaultFinalizeDeps(): FinalizeDeps {
  return {
    health: async () => {
      // Import differito: la route di salute importa mezzo calendario, qui serve solo lo stato.
      const { computeCalendarHealth } = await import('../../../routes/calendar/health');
      const report = await computeCalendarHealth();
      return { status: report.status, reasons: report.reasons.map((r) => r.code) };
    },
    now: () => new Date(),
  };
}

// ─── Blocchi ───────────────────────────────

/** Blocco del finalize con il messaggio per il wizard (nessun dato personale). */
export interface FinalizeBlocker {
  reason: PreconditionReason;
  message: string;
}

/**
 * Motivi che impediscono il finalize adesso, con i messaggi (contratto §5.4,
 * passo preflight). Sola lettura.
 */
export async function finalizeBlockersDetailed(
  db: Db,
  now: Date = new Date(),
  opts: { deps?: Partial<FinalizeDeps>; state?: MigrationBackendState; transitionId?: string | null } = {},
): Promise<FinalizeBlocker[]> {
  const deps: FinalizeDeps = { ...defaultFinalizeDeps(), ...(opts.deps ?? {}) };
  const state = opts.state ?? await readTransitionState(db);
  const out: FinalizeBlocker[] = [];
  if (state.mode !== 'radicale') {
    out.push({ reason: 'MODE_NOT_RADICALE', message: `il backend è in mode ${state.mode}: la finestra si chiude solo da radicale` });
    return out;
  }
  const active = await getActiveTransition(db);
  if (active && active.id !== (opts.transitionId ?? null)) {
    out.push({ reason: 'TRANSITION_ACTIVE', message: `transizione ${active.kind} attiva dal ${active.started_at.toISOString()}` });
  }
  if (!state.cutover_at) {
    out.push({ reason: 'FINALIZE_TOO_EARLY', message: 'istante del cutover non registrato' });
  } else {
    const available = state.cutover_at.getTime() + F4_LIMITS.finalizeMinDays * DAY_MS;
    if (now.getTime() < available) {
      out.push({ reason: 'FINALIZE_TOO_EARLY', message: `la finestra si chiude non prima del ${new Date(available).toISOString()} (${F4_LIMITS.finalizeMinDays} giorni dal cutover)` });
    }
  }
  const [counts] = await db<Array<{ dead: number; failed: number }>>`
    SELECT
      (SELECT count(*)::int FROM cal_jobs WHERE status = 'dead') AS dead,
      (SELECT count(*)::int FROM cal_migration_reverse_state WHERE status = 'failed') AS failed
  `;
  const dead = Number(counts?.dead ?? 0);
  const failed = Number(counts?.failed ?? 0);
  if (dead > 0) out.push({ reason: 'DEAD_JOBS', message: `${dead} ${dead === 1 ? 'job del calendario fallito' : 'job del calendario falliti'} definitivamente: vanno risolti o scartati` });
  if (failed > 0) out.push({ reason: 'REVERSE_FAILED_OPEN', message: `${failed} ${failed === 1 ? 'oggetto' : 'oggetti'} con REVERSE_FAILED nella proiezione inversa` });
  try {
    const health = await deps.health();
    if (health.status !== 'ok') {
      out.push({ reason: 'HEALTH_NOT_GREEN', message: `salute del calendario ${health.status}${health.reasons.length ? ` (${health.reasons.slice(0, 5).join(', ')})` : ''}` });
    }
  } catch (err) {
    log.warn({ err: err instanceof Error ? err.message : String(err) }, 'salute del calendario non calcolata per il finalize');
    out.push({ reason: 'HEALTH_NOT_GREEN', message: 'salute del calendario non calcolabile' });
  }
  return out;
}

/** Motivi che impediscono il finalize (contratto §5.4): lista vuota se si può chiudere la finestra. */
export async function finalizeBlockers(db: Db, now: Date = new Date(), opts: { deps?: Partial<FinalizeDeps> } = {}): Promise<PreconditionReason[]> {
  const list = await finalizeBlockersDetailed(db, now, opts);
  return [...new Set(list.map((b) => b.reason))];
}

// ─── Run ───────────────────────────────

/** Parametri del run normalizzati. */
export function normalizeFinalizeParams(params: Partial<FinalizeParams> | null | undefined): FinalizeParams {
  const action = params?.action ?? 'start';
  if (action !== 'start' && action !== 'resume') throw new MigrationError('VALIDATION_FAILED', 'action: attesi start o resume');
  return { action };
}

/** true se la funzione SQL della 167 (F7) esiste nel database. */
async function legacyFinalizeAvailable(db: Db): Promise<boolean> {
  const [row] = await db<Array<{ ok: boolean }>>`SELECT to_regprocedure('calendar_finalize_legacy()') IS NOT NULL AS ok`;
  return row?.ok === true;
}

async function buildSummary(handle: TransitionHandle): Promise<FinalizeSummary> {
  const db = handle.ctx.db;
  const journal = await readJournal(db, handle.record.id);
  const step = (name: string) => journal.find((s) => s.step === name);
  const stop = step('stop_reverse');
  const legacy = step('legacy_finalize');
  const state = await readTransitionState(db);
  const legacyDone = legacy?.status === 'done';
  return {
    transition_id: handle.record.id,
    finalized_at: (state.finalized_at ?? handle.record.finished_at ?? new Date()).toISOString(),
    legacy_finalized: legacyDone,
    legacy_note: legacyDone ? null : (typeof legacy?.data.reason === 'string' ? legacy.data.reason : LEGACY_FINALIZE_PENDING_NOTE),
    reverse_jobs_dropped: typeof stop?.data.dropped === 'number' ? stop.data.dropped : 0,
    steps: await journalViews(handle),
  };
}

/** Run `finalize` (contratto §5.4): avvio o ripresa. Non annullabile (nessun cambio di permessi). */
export async function runFinalize(ctx: MigrationRunContext<FinalizeParams>, depsIn: Partial<FinalizeDeps> = {}): Promise<FinalizeSummary> {
  const deps: FinalizeDeps = { ...defaultFinalizeDeps(), ...depsIn };
  const params = normalizeFinalizeParams(ctx.params);
  const tctx: TransitionContext = { ...transitionContextFromRun(ctx as MigrationRunContext<unknown>), now: deps.now };

  // Stesso run ripreso dall'esecutore a transizione già conclusa: l'esito registrato.
  const latest = await getLatestTransition(ctx.db, 'finalize');
  if (latest && latest.status === 'completed' && latest.run_id === ctx.runId) return buildSummary({ ctx: tctx, record: latest });

  const { handle, resumed } = await beginTransition({ ctx: tctx, kind: 'finalize', resume: params.action === 'resume' });
  if (resumed) log.info({ transitionId: handle.record.id, runId: ctx.runId }, 'ripresa del finalize dal primo passo non concluso');
  const total = FINALIZE_STEPS.length;
  const progress = (index: number, message: string): Promise<void> => ctx.progress({ phase: FINALIZE_STEPS[index], done: index, total, message });

  // 1. Preflight.
  await progress(0, 'Controllo delle condizioni per chiudere la finestra di rollback');
  await runStep(handle, 'preflight', async () => {
    const blockers = await finalizeBlockersDetailed(ctx.db, deps.now(), { deps, transitionId: handle.record.id });
    if (blockers.length) {
      throw preconditionError(`Finestra di rollback non ancora chiudibile: ${blockers.map((b) => b.message).join('; ')}`, [...new Set(blockers.map((b) => b.reason))]);
    }
    return { checked_at: deps.now().toISOString() };
  });

  // 2. Proiezione inversa ferma.
  await progress(1, 'Proiezione inversa ferma');
  await runStep(handle, 'stop_reverse', async () => {
    const { closePendingReverseProjectionJobs } = await import('./reverse-projector');
    const dropped = await closePendingReverseProjectionJobs(ctx.db, 'finalize');
    return { dropped };
  });

  // 3. Stato: mode finalized (policy live, epoch invariato).
  await progress(2, 'Mode finalized: la finestra di rollback è chiusa');
  if (!(await completedStep(handle, 'state'))) {
    const now = deps.now();
    await stateStep(handle, 'state', { expectMode: 'radicale', mode: 'finalized', set: { finalized_at: now, rollback_until: null }, data: { finalized_at: now.toISOString() } });
  }

  // 4. Tabella legacy (F7).
  await progress(3, 'Tabella legacy');
  if (!(await completedStep(handle, 'legacy_finalize'))) {
    if (await legacyFinalizeAvailable(ctx.db)) {
      await runStep(handle, 'legacy_finalize', async () => {
        await ctx.db`SELECT calendar_finalize_legacy()`;
        return { applied: true };
      });
    } else {
      await skipStep(handle, 'legacy_finalize', LEGACY_FINALIZE_PENDING_NOTE);
    }
  }

  await completeTransition(handle, { outcome: 'Finestra di rollback chiusa: Radicale è definitivo' });
  await ctx.progress({ phase: 'done', done: total, total, message: 'Finestra di rollback chiusa' });
  log.info({ transitionId: handle.record.id, actor: ctx.actor }, 'finalize completato: mode finalized, proiezione inversa ferma');
  return buildSummary(handle);
}
