/**
 * Cron: advances marketing automation enrollments.
 *
 * Pulls due runs (status active, next_run_at past, FOR UPDATE SKIP LOCKED),
 * runs the step at current_step_order, then schedules the next step after its
 * delay — or completes the run. Paused automations leave their runs untouched
 * (re-checked next tick). Reuses executeStep() for delivery.
 */
import { sql } from '../db';
import { executeStep } from '../lib/marketing/automation';
import { logger } from '../lib/logger';

const log = logger.child({ scope: 'marketing-automations' });

interface RunRow { id: string; automation_id: string; contact_id: string; current_step_order: number; }

export async function runMarketingAutomations(): Promise<void> {
  let due: RunRow[];
  try {
    due = await sql<RunRow[]>`
      SELECT id, automation_id, contact_id, current_step_order
      FROM mkt_automation_runs
      WHERE status = 'active' AND next_run_at <= now()
      ORDER BY next_run_at
      LIMIT 100
      FOR UPDATE SKIP LOCKED`;
  } catch (err) {
    log.error({ err }, 'due-run query failed');
    return;
  }
  if (!due.length) return;
  log.info({ count: due.length }, 'processing automation runs');

  for (const run of due) {
    try {
      // Skip (don't advance) if the automation was paused/deleted.
      const [auto] = await sql`SELECT status FROM mkt_automations WHERE id = ${run.automation_id}`;
      if (!auto || auto.status !== 'active') continue;

      const [step] = await sql`
        SELECT action_type, action_config FROM mkt_automation_steps
        WHERE automation_id = ${run.automation_id} AND step_order = ${run.current_step_order}`;
      if (!step) {
        await sql`UPDATE mkt_automation_runs SET status='completed', completed_at=now() WHERE id=${run.id}`;
        continue;
      }

      const [contact] = await sql`
        SELECT id, email, email_consent, email_norm, phone, customer_id, lead_id, unsubscribe_token,
               first_name, last_name, company, role
        FROM mkt_contacts WHERE id = ${run.contact_id}`;
      if (!contact) {
        await sql`UPDATE mkt_automation_runs SET status='cancelled', completed_at=now() WHERE id=${run.id}`;
        continue;
      }

      await executeStep(step as { action_type: string; action_config: Record<string, unknown> }, contact as never);

      // Advance to the next step (scheduled after its own delay) or complete.
      const [next] = await sql`
        SELECT step_order, delay_minutes FROM mkt_automation_steps
        WHERE automation_id = ${run.automation_id} AND step_order > ${run.current_step_order}
        ORDER BY step_order LIMIT 1`;
      if (next) {
        await sql`UPDATE mkt_automation_runs
                  SET current_step_order = ${next.step_order}, next_run_at = now() + make_interval(mins => ${next.delay_minutes})
                  WHERE id = ${run.id}`;
      } else {
        await sql`UPDATE mkt_automation_runs SET status='completed', completed_at=now() WHERE id=${run.id}`;
      }
    } catch (err) {
      log.error({ err, runId: run.id }, 'automation step failed');
      // Don't retry-loop the same run forever: push it out 1h.
      await sql`UPDATE mkt_automation_runs SET next_run_at = now() + interval '1 hour' WHERE id = ${run.id}`.catch(() => {});
    }
  }
}
