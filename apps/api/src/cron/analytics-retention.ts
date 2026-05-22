/**
 * analytics-retention — Daily purge of analytics partitions older than 13 months.
 * Calls purge_old_analytics(): the partition-based version from migration 086
 * (which DETACH + DROPs whole partitions, fast) supersedes the earlier row-DELETE
 * version in migration 038 — 13 months is the effective retention window.
 */
import { sql } from '../db';
import { logger } from '../lib/logger';

const log = logger.child({ scope: 'analytics-retention' });

export async function runAnalyticsRetention(): Promise<void> {
  const [row] = await sql`SELECT purge_old_analytics() AS count` as Array<{ count: number }>;
  const dropped = row?.count ?? 0;
  if (dropped > 0) {
    log.info(`dropped ~${dropped} rows in expired partitions`);
  }
}
