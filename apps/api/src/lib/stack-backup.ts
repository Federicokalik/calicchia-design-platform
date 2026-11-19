/**
 * Backup coordinato dello stack (database più volume di Radicale) eseguito dal
 * servizio `backup` (apps/backup, migrazione 173).
 *
 * L'API non esegue mai il backup: legge lo stato (heartbeat del servizio, run
 * recenti, ultimo backup registrato in calendar_backend_state) e mette in coda
 * le richieste dell'admin, che il servizio raccoglie entro un giro
 * (BACKUP_POLL_SECONDS, 30 s di default). Così il backup non dipende dalla
 * salute dell'API e l'API non ha bisogno del volume in scrittura, di pg_dump
 * né delle credenziali S4 per il backup.
 */

import { sql } from '../db';

/** Il servizio è considerato attivo se l'ultimo heartbeat è più recente di così. */
export const STACK_BACKUP_AGENT_ONLINE_SECONDS = 180;
/** Run recenti mostrati nell'admin. */
export const STACK_BACKUP_RECENT_RUNS = 10;

export type StackBackupRunStatus = 'queued' | 'running' | 'succeeded' | 'incomplete' | 'failed' | 'skipped';

export interface StackBackupRun {
  id: string;
  trigger: 'schedule' | 'admin';
  requested_by: string | null;
  status: StackBackupRunStatus;
  requested_at: string;
  started_at: string | null;
  finished_at: string | null;
  exit_code: number | null;
  backup_id: string | null;
  offsite: boolean | null;
  message: string | null;
  log_tail: string | null;
}

export interface StackBackupAgent {
  online: boolean;
  seen_at: string;
  started_at: string;
  version: string | null;
  interval_hours: number;
  next_run_at: string | null;
  s4_configured: boolean;
  alerts_configured: boolean;
}

export interface LastStackBackup {
  id: string | null;
  at: string | null;
  complete: boolean | null;
  epoch: number | null;
  volume_id: string | null;
}

export interface StackBackupStatus {
  /** false prima della migrazione 173: niente servizio, niente coda. */
  installed: boolean;
  /** null se il servizio non ha mai scritto un heartbeat. */
  agent: StackBackupAgent | null;
  /** Run in coda o in corso (al massimo uno). */
  active: StackBackupRun | null;
  runs: StackBackupRun[];
  /** Ultimo backup completo registrato dallo script (servizio o cron dell'host). */
  last_stack_backup: LastStackBackup | null;
}

const iso = (v: unknown): string | null => (v instanceof Date ? v.toISOString() : typeof v === 'string' ? v : null);

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- righe di postgres-js
function toRun(r: any): StackBackupRun {
  return {
    id: r.id,
    trigger: r.trigger,
    requested_by: r.requested_by ?? null,
    status: r.status,
    requested_at: iso(r.requested_at)!,
    started_at: iso(r.started_at),
    finished_at: iso(r.finished_at),
    exit_code: r.exit_code ?? null,
    backup_id: r.backup_id ?? null,
    offsite: r.offsite ?? null,
    message: r.message ?? null,
    log_tail: r.log_tail ?? null,
  };
}

async function tablesInstalled(): Promise<boolean> {
  const [row] = await sql<Array<{ ok: boolean }>>`
    SELECT to_regclass('public.stack_backup_runs') IS NOT NULL
       AND to_regclass('public.stack_backup_agent') IS NOT NULL AS ok
  `;
  return row?.ok === true;
}

async function readLastStackBackup(): Promise<LastStackBackup | null> {
  const [col] = await sql<Array<{ ok: boolean }>>`
    SELECT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'calendar_backend_state' AND column_name = 'last_stack_backup'
    ) AS ok
  `;
  if (!col?.ok) return null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- jsonb libero scritto dallo script
  const [row] = await sql<Array<{ rec: any }>>`SELECT last_stack_backup AS rec FROM calendar_backend_state WHERE id`;
  const rec = row?.rec;
  if (!rec || typeof rec !== 'object') return null;
  return {
    id: typeof rec.id === 'string' ? rec.id : null,
    at: typeof rec.at === 'string' ? rec.at : null,
    complete: typeof rec.complete === 'boolean' ? rec.complete : null,
    epoch: typeof rec.epoch === 'number' ? rec.epoch : null,
    volume_id: typeof rec.volume_id === 'string' ? rec.volume_id : null,
  };
}

export async function readStackBackupStatus(): Promise<StackBackupStatus> {
  const last = await readLastStackBackup();
  if (!(await tablesInstalled())) {
    return { installed: false, agent: null, active: null, runs: [], last_stack_backup: last };
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- riga singola
  const [agentRow] = await sql<any[]>`
    SELECT seen_at, started_at, version, interval_hours, next_run_at, s4_configured, alerts_configured,
           seen_at > now() - make_interval(secs => ${STACK_BACKUP_AGENT_ONLINE_SECONDS}) AS online
    FROM stack_backup_agent WHERE id
  `;
  const runs = await sql`
    SELECT id::text AS id, trigger, requested_by, status, requested_at, started_at, finished_at,
           exit_code, backup_id, offsite, message, log_tail
    FROM stack_backup_runs ORDER BY requested_at DESC LIMIT ${STACK_BACKUP_RECENT_RUNS}
  `;
  const [activeRow] = await sql`
    SELECT id::text AS id, trigger, requested_by, status, requested_at, started_at, finished_at,
           exit_code, backup_id, offsite, message, log_tail
    FROM stack_backup_runs WHERE status IN ('queued', 'running') LIMIT 1
  `;
  return {
    installed: true,
    agent: agentRow
      ? {
          online: agentRow.online === true,
          seen_at: iso(agentRow.seen_at)!,
          started_at: iso(agentRow.started_at)!,
          version: agentRow.version ?? null,
          interval_hours: agentRow.interval_hours,
          next_run_at: iso(agentRow.next_run_at),
          s4_configured: agentRow.s4_configured === true,
          alerts_configured: agentRow.alerts_configured === true,
        }
      : null,
    active: activeRow ? toRun(activeRow) : null,
    runs: runs.map(toRun),
    last_stack_backup: last,
  };
}

export type EnqueueStackBackupResult =
  | { kind: 'queued'; run: StackBackupRun }
  | { kind: 'not_installed' }
  | { kind: 'offline'; seen_at: string | null }
  | { kind: 'busy'; run: StackBackupRun | null };

/**
 * Mette in coda un run chiesto dall'admin. Rifiuta se il servizio non è
 * attivo (la richiesta resterebbe in coda senza che nessuno la esegua) o se un
 * run è già in coda o in corso (indice unico parziale della 173).
 */
export async function enqueueStackBackup(requestedBy: string): Promise<EnqueueStackBackupResult> {
  if (!(await tablesInstalled())) return { kind: 'not_installed' };
  const [agent] = await sql<Array<{ seen_at: Date; online: boolean }>>`
    SELECT seen_at, seen_at > now() - make_interval(secs => ${STACK_BACKUP_AGENT_ONLINE_SECONDS}) AS online
    FROM stack_backup_agent WHERE id
  `;
  if (!agent?.online) return { kind: 'offline', seen_at: agent ? iso(agent.seen_at) : null };
  const [inserted] = await sql`
    INSERT INTO stack_backup_runs (trigger, requested_by) VALUES ('admin', ${requestedBy})
    ON CONFLICT DO NOTHING
    RETURNING id::text AS id, trigger, requested_by, status, requested_at, started_at, finished_at,
              exit_code, backup_id, offsite, message, log_tail
  `;
  if (inserted) return { kind: 'queued', run: toRun(inserted) };
  const [active] = await sql`
    SELECT id::text AS id, trigger, requested_by, status, requested_at, started_at, finished_at,
           exit_code, backup_id, offsite, message, log_tail
    FROM stack_backup_runs WHERE status IN ('queued', 'running') LIMIT 1
  `;
  return { kind: 'busy', run: active ? toRun(active) : null };
}
