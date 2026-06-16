/**
 * Cron Engine — Scheduled automations
 * Jobs run at specific hours, not on server restart.
 */

import { captureException } from '../lib/bugsink';
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
import { runDunningEngine } from './dunning-engine';
import { runIcsPull } from './ics-pull';
import { runWhatsAppMediaFetch } from './whatsapp-media-fetch';
import { runWhatsAppScheduled } from './whatsapp-scheduled';
import { runWhatsAppContactsSync } from './whatsapp-contacts-sync';
import { runDataRetention } from './data-retention';
import { runItalianHolidays } from './italian-holidays';
import { runKbS4Sync } from './kb-sync';
import { runMarketingAudienceSync } from './marketing-audience-sync';
import { runMarketingSend } from './marketing-send';
import { runMarketingSendWhatsApp } from './marketing-send-whatsapp';
import { runMarketingAutomations } from './marketing-automations';
import { logger } from '../lib/logger';

const log = logger.child({ scope: 'cron' });

interface LongTimer {
  clear: () => void;
}

interface CronJob {
  name: string;
  intervalMs: number;
  runAtHour?: number; // Run at this hour (0-23). If set, first run waits until this hour.
  run: () => Promise<void>;
  lastRun?: Date;
  timer?: LongTimer;
}

// Node's setTimeout stores the delay in a 32-bit signed int. A delay greater
// than this is NOT honoured — it silently wraps to 1ms and emits a
// TimeoutOverflowWarning, turning a long-interval job into a busy-loop (this
// is exactly what happened to analytics-geo-refresh: a ~30-day interval fired
// every ~1ms). Chain timers so any delay, however long, is respected.
const MAX_TIMEOUT_MS = 2_147_483_647; // 2^31 - 1 ≈ 24.8 days

function longTimeout(fn: () => void, delayMs: number): LongTimer {
  let timer: ReturnType<typeof setTimeout>;
  const arm = (remaining: number) => {
    if (remaining <= MAX_TIMEOUT_MS) {
      timer = setTimeout(fn, Math.max(0, remaining));
    } else {
      timer = setTimeout(() => arm(remaining - MAX_TIMEOUT_MS), MAX_TIMEOUT_MS);
    }
  };
  arm(delayMs);
  return { clear: () => clearTimeout(timer) };
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
    intervalMs: 7 * 24 * 60 * 60 * 1000, // weekly (MaxMind ships GeoLite2 twice a week)
    runAtHour: 4,
    run: runAnalyticsGeoRefresh,
  },
  {
    name: 'dunning-engine',
    intervalMs: 24 * 60 * 60 * 1000,
    runAtHour: 9, // 9:00 italiana
    run: runDunningEngine,
  },
  {
    name: 'ics-pull',
    intervalMs: 15 * 60 * 1000,
    run: runIcsPull,
  },
  {
    name: 'whatsapp-media-fetch',
    intervalMs: 30 * 1000,
    run: runWhatsAppMediaFetch,
  },
  {
    name: 'whatsapp-scheduled',
    intervalMs: 60 * 1000,
    run: runWhatsAppScheduled,
  },
  {
    // Nomi rubrica WhatsApp (GOWA /user/my/contacts): sync giornaliero.
    name: 'whatsapp-contacts-sync',
    intervalMs: 24 * 60 * 60 * 1000,
    runAtHour: 6,
    run: async () => { await runWhatsAppContactsSync(); },
  },
  {
    name: 'data-retention',
    intervalMs: 24 * 60 * 60 * 1000,
    runAtHour: 5,
    run: runDataRetention,
  },
  {
    // Festività nazionali italiane: nessun runAtHour → prima esecuzione ~30s
    // dopo il boot (seed immediato al deploy), poi settimanale. Idempotente,
    // mantiene una finestra mobile di 6 anni (Pasqua inclusa, auto-calcolata).
    name: 'italian-holidays',
    intervalMs: 7 * 24 * 60 * 60 * 1000,
    run: runItalianHolidays,
  },
  {
    // KB → S4 backup: retries a pending push (admin edit that didn't reach S4).
    // No-op when nothing is owed; re-alerts on Telegram daily if S4 stays down.
    name: 'kb-s4-sync',
    intervalMs: 24 * 60 * 60 * 1000,
    runAtHour: 7,
    run: runKbS4Sync,
  },
  {
    // Marketing audience projection: CRM (subscribers/leads/customers) → mkt_contacts.
    // Daily; the newsletter-confirm escalation happens inline. Idempotent.
    name: 'marketing-audience-sync',
    intervalMs: 24 * 60 * 60 * 1000,
    runAtHour: 4,
    run: runMarketingAudienceSync,
  },
  {
    // Marketing send queue drainer (email). Throttled batches per campaign.
    name: 'marketing-send',
    intervalMs: 60 * 1000,
    run: runMarketingSend,
  },
  {
    // WhatsApp broadcast drainer — conservative cadence (anti-ban).
    name: 'marketing-send-whatsapp',
    intervalMs: 2 * 60 * 1000,
    run: runMarketingSendWhatsApp,
  },
  {
    // Marketing automation drip engine — advances due enrollments.
    name: 'marketing-automations',
    intervalMs: 60 * 1000,
    run: runMarketingAutomations,
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
      log.info(`Running: ${job.name}`);
      await job.run();
      job.lastRun = new Date();
    } catch (err) {
      log.error({ err }, `Error in ${job.name}`);
      // Report to Bugsink — cron failures are otherwise invisible in prod (BK-05).
      captureException(err instanceof Error ? err : new Error(String(err)), {
        source: 'cron',
        job: job.name,
      });
    }
    job.timer = longTimeout(execute, job.intervalMs);
  };

  // If runAtHour is set, wait until that hour. Otherwise start after 30s.
  const delay = job.runAtHour !== undefined
    ? msUntilHour(job.runAtHour)
    : 30_000;

  log.info(`${job.name} — next run in ${Math.round(delay / 60000)}min`);
  job.timer = longTimeout(execute, delay);
}

export function startCronEngine() {
  log.info(`Starting ${jobs.length} scheduled jobs`);
  for (const job of jobs) {
    scheduleJob(job);
  }
}

export function stopCronEngine() {
  for (const job of jobs) {
    if (job.timer) job.timer.clear();
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
