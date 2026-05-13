/**
 * Cron Engine — Scheduled automations
 * Jobs run at specific hours, not on server restart.
 */

import { runDomainAlerts } from './domain-alerts';
import { runQuoteExpiry } from './quote-expiry';
import { runDailyDigest } from './daily-digest';
import { runBrainAnalysis } from './brain-analysis';
import { runWorkflowScheduler } from './workflow-scheduler';
import { runMailSync } from './mail-sync';
import { runBookingReminders } from './booking-reminders';
import { runLeadAuditSequence } from '../jobs/lead-audit-sequence';
import { runAnalyticsRetention } from './analytics-retention';
import { runAnalyticsPartitionMaintenance } from './analytics-partition-maintenance';
import { runAnalyticsGeoRefresh } from './analytics-geo-refresh';

interface CronJob {
  name: string;
  intervalMs: number;
  runAtHour?: number; // Run at this hour (0-23). If set, first run waits until this hour.
  run: () => Promise<void>;
  lastRun?: Date;
  timer?: ReturnType<typeof setTimeout>;
}

const jobs: CronJob[] = [
  {
    name: 'lead-audit-sequence',
    intervalMs: 60 * 60 * 1000,
    run: runLeadAuditSequence,
  },
  {
    name: 'domain-alerts',
    intervalMs: 24 * 60 * 60 * 1000,
    runAtHour: 8,
    run: runDomainAlerts,
  },
  {
    name: 'quote-expiry',
    intervalMs: 24 * 60 * 60 * 1000,
    runAtHour: 0, // midnight
    run: runQuoteExpiry,
  },
  {
    name: 'daily-digest',
    intervalMs: 24 * 60 * 60 * 1000,
    runAtHour: 8,
    run: runDailyDigest,
  },
  {
    name: 'brain-analysis',
    intervalMs: 6 * 60 * 60 * 1000,
    run: runBrainAnalysis,
  },
  {
    name: 'workflow-scheduler',
    intervalMs: 5 * 60 * 1000,
    run: runWorkflowScheduler,
  },
  {
    name: 'mail-sync',
    intervalMs: 5 * 60 * 1000,
    run: runMailSync,
  },
  {
    name: 'booking-reminders',
    intervalMs: 15 * 60 * 1000,
    run: runBookingReminders,
  },
  {
    name: 'analytics-retention',
    intervalMs: 24 * 60 * 60 * 1000,
    runAtHour: 3,
    run: runAnalyticsRetention,
  },
  {
    name: 'analytics-partition-maintenance',
    intervalMs: 24 * 60 * 60 * 1000,
    runAtHour: 2,
    run: runAnalyticsPartitionMaintenance,
  },
  {
    name: 'analytics-geo-refresh',
    intervalMs: 30 * 24 * 60 * 60 * 1000, // ~monthly
    runAtHour: 4,
    run: runAnalyticsGeoRefresh,
  },
];

function msUntilHour(hour: number): number {
  const now = new Date();
  const target = new Date(now);
  target.setHours(hour, 0, 0, 0);
  if (target.getTime() <= now.getTime()) {
    target.setDate(target.getDate() + 1);
  }
  return target.getTime() - now.getTime();
}

function scheduleJob(job: CronJob) {
  const execute = async () => {
    try {
      console.log(`[Cron] Running: ${job.name}`);
      await job.run();
      job.lastRun = new Date();
    } catch (err) {
      console.error(`[Cron] Error in ${job.name}:`, err);
    }
    job.timer = setTimeout(execute, job.intervalMs);
  };

  // If runAtHour is set, wait until that hour. Otherwise start after 30s.
  const delay = job.runAtHour !== undefined
    ? msUntilHour(job.runAtHour)
    : 30_000;

  console.log(`[Cron] ${job.name} — next run in ${Math.round(delay / 60000)}min`);
  job.timer = setTimeout(execute, delay);
}

export function startCronEngine() {
  console.log(`[Cron] Starting ${jobs.length} scheduled jobs`);
  for (const job of jobs) {
    scheduleJob(job);
  }
}

export function stopCronEngine() {
  for (const job of jobs) {
    if (job.timer) clearTimeout(job.timer);
  }
}

export function getCronStatus() {
  return jobs.map((j) => ({
    name: j.name,
    interval: `${j.intervalMs / 1000 / 60 / 60}h`,
    runAtHour: j.runAtHour ?? null,
    lastRun: j.lastRun?.toISOString() || null,
  }));
}
