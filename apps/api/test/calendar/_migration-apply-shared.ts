/**
 * Utilità condivise dai test del gruppo APPLY della F3 (apply, verifica e
 * report): contesto di un run (MigrationRunContext) con la riga reale in
 * cal_migration_runs e le righe salvate davvero in cal_migration_items (come
 * l'esecutore di runs.ts: seq in ordine, id restituiti), così il riporto delle
 * accettazioni e i verdetti leggono il database; chiusura del run con il
 * riassunto. Il nome inizia con "_": il runner esegue solo i file *.test.ts.
 */

import { sql } from '../helpers/db';
import { logger } from '../../src/lib/logger';
import {
  MigrationError,
  type MigrationItemInput,
  type MigrationProgress,
  type MigrationRunContext,
  type MigrationRunKind,
} from '../../src/lib/calendar/migration/types';

export const TEST_ACTOR = 'admin:test-apply';

/** Chiude come riusciti i run attivi lasciati da un test (un solo run attivo alla volta). */
export async function closeActiveRuns(): Promise<void> {
  await sql`
    UPDATE cal_migration_runs SET status = 'succeeded', finished_at = now(), started_at = coalesce(started_at, now())
    WHERE status IN ('queued', 'running')
  `;
}

export interface PersistedRun<P> {
  ctx: MigrationRunContext<P>;
  progress: MigrationProgress[];
  cancel(): void;
  /** Chiude il run come l'esecutore: succeeded con il riassunto, o failed/cancelled con il codice. */
  finish(outcome: { summary?: object; error?: unknown }): Promise<void>;
}

/** Inserisce una riga in cal_migration_items per ogni input (seq successivo all'ultimo del run). */
export async function insertItems(runId: string, rows: readonly MigrationItemInput[]): Promise<string[]> {
  const ids: string[] = [];
  for (const r of rows) {
    const [row] = await sql<Array<{ id: string }>>`
      INSERT INTO cal_migration_items (
        run_id, seq, item_type, calendar_id, collection_name, href, legacy_key, action, outcome, code, level, severity, expected, detail, forced
      ) VALUES (
        ${runId}::uuid,
        (SELECT COALESCE(max(seq), -1) + 1 FROM cal_migration_items WHERE run_id = ${runId}::uuid),
        ${r.item_type}, ${r.calendar_id ?? null}::uuid, ${r.collection_name ?? null}, ${r.href ?? null}, ${r.legacy_key ?? null},
        ${r.action ?? null}, ${r.outcome ?? null}, ${r.code ?? null}, ${r.level ?? null}, ${r.severity ?? 'info'},
        ${r.item_type === 'diff' ? (r.expected ?? false) : null}, ${sql.json((r.detail ?? {}) as never)}, ${r.forced ?? false}
      )
      RETURNING id::text AS id
    `;
    ids.push(row.id);
  }
  return ids;
}

/**
 * Run 'running' con la riga in cal_migration_runs e righe persistite. Il
 * segnale si può accendere a mano (cancel) o da una funzione chiamata a ogni
 * avanzamento (annullamento a metà).
 */
export async function persistedRun<P extends object>(
  kind: MigrationRunKind,
  params: P,
  opts: { planRunId?: string | null; planHash?: string | null; attempt?: number; runId?: string; trigger?: 'admin' | 'schedule' | 'shadow'; onProgress?: (p: MigrationProgress, cancel: () => void) => void } = {},
): Promise<PersistedRun<P>> {
  let runId = opts.runId;
  if (!runId) {
    await closeActiveRuns();
    const [row] = await sql<Array<{ id: string }>>`
      INSERT INTO cal_migration_runs (kind, status, trigger, requested_by, params, plan_run_id, plan_hash, started_at, attempts)
      VALUES (${kind}, 'running', ${opts.trigger ?? 'admin'}, ${TEST_ACTOR}, ${sql.json(params as never)}, ${opts.planRunId ?? null}::uuid, ${opts.planHash ?? null}, now(), ${opts.attempt ?? 1})
      RETURNING id::text AS id
    `;
    runId = row.id;
  }
  const [row] = await sql<Array<{ params: P }>>`SELECT params FROM cal_migration_runs WHERE id = ${runId}::uuid`;
  const progress: MigrationProgress[] = [];
  const controller = new AbortController();
  const cancel = (): void => controller.abort();
  const id = runId;
  const ctx: MigrationRunContext<P> = {
    runId: id,
    kind,
    trigger: opts.trigger ?? 'admin',
    actor: TEST_ACTOR,
    params: row?.params ?? params,
    planRunId: opts.planRunId ?? null,
    planHash: opts.planHash ?? null,
    attempt: opts.attempt ?? 1,
    signal: controller.signal,
    log: logger.child({ scope: 'test-migration-apply' }),
    db: sql,
    async progress(update) {
      progress.push(update);
      opts.onProgress?.(update, cancel);
    },
    async addItems(rows) {
      return insertItems(id, rows);
    },
    throwIfCancelled() {
      if (controller.signal.aborted) throw new MigrationError('CANCELLED', 'Run annullato');
    },
  };
  return {
    ctx,
    progress,
    cancel,
    async finish(outcome) {
      if (outcome.error) {
        const code = outcome.error instanceof MigrationError ? outcome.error.code : 'INTERNAL';
        const status = code === 'CANCELLED' ? 'cancelled' : 'failed';
        await sql`
          UPDATE cal_migration_runs SET status = ${status}, error_code = ${code}, error = ${String((outcome.error as Error).message ?? outcome.error).slice(0, 500)}, finished_at = now()
          WHERE id = ${id}::uuid
        `;
        return;
      }
      await sql`
        UPDATE cal_migration_runs SET status = 'succeeded', summary = ${sql.json((outcome.summary ?? {}) as never)}, finished_at = now()
        WHERE id = ${id}::uuid
      `;
    },
  };
}

/** Esegue `fn` con il contesto di un run e chiude il run con l'esito (come l'esecutore). */
export async function runToEnd<P extends object, S extends object>(
  kind: MigrationRunKind,
  params: P,
  fn: (ctx: MigrationRunContext<P>) => Promise<S>,
  opts: Parameters<typeof persistedRun<P>>[2] = {},
): Promise<{ summary: S; runId: string; progress: MigrationProgress[] }> {
  const run = await persistedRun(kind, params, opts);
  try {
    const summary = await fn(run.ctx);
    await run.finish({ summary });
    return { summary, runId: run.ctx.runId, progress: run.progress };
  } catch (err) {
    await run.finish({ error: err });
    throw err;
  }
}

export interface ItemRow {
  id: string;
  seq: number;
  item_type: string;
  calendar_id: string | null;
  href: string | null;
  legacy_key: string | null;
  action: string | null;
  outcome: string | null;
  code: string | null;
  level: string | null;
  severity: string;
  expected: boolean | null;
  forced: boolean;
  accepted_at: Date | null;
  detail: Record<string, unknown>;
}

/** Righe di un run in ordine. */
export async function runItems(runId: string): Promise<ItemRow[]> {
  return sql<ItemRow[]>`
    SELECT id::text AS id, seq, item_type, calendar_id::text AS calendar_id, href, legacy_key, action, outcome, code, level, severity,
           expected, forced, accepted_at, detail
    FROM cal_migration_items WHERE run_id = ${runId}::uuid ORDER BY seq
  `;
}
