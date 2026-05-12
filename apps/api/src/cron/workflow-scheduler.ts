/**
 * Workflow Scheduler — runs active cron-triggered workflows
 */

import { sql } from '../db';
import { executeWorkflow } from '../lib/workflow/engine';

export async function runWorkflowScheduler() {
  const workflows = await sql`
    SELECT id, name, trigger_config, last_executed_at
    FROM workflows
    WHERE status = 'active' AND trigger_type = 'cron'
  `;

  for (const wf of workflows) {
    const config = typeof wf.trigger_config === 'string' ? JSON.parse(wf.trigger_config) : wf.trigger_config;
    const intervalHours = config.interval_hours || 24;
    const intervalMs = intervalHours * 60 * 60 * 1000;

    // Check if enough time has passed since last execution
    const lastRun = wf.last_executed_at ? new Date(wf.last_executed_at).getTime() : 0;
    const now = Date.now();

    if (now - lastRun >= intervalMs) {
      console.log(`[Workflow Scheduler] Executing: ${wf.name} (${wf.id})`);
      executeWorkflow(wf.id, { scheduled: true, triggered_at: new Date().toISOString() })
        .catch((err) => console.error(`[Workflow Scheduler] Error executing ${wf.name}:`, err));
    }
  }
}
