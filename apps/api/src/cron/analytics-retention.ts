/**
 * analytics-retention — Daily purge of analytics partitions older than 13 months.
 * Calls the PG function which DETACH + DROP whole partitions (fast).
 */
import { sql } from '../db';

export async function runAnalyticsRetention(): Promise<void> {
  const [row] = await sql`SELECT purge_old_analytics() AS count` as Array<{ count: number }>;
  const dropped = row?.count ?? 0;
  if (dropped > 0) {
    console.log(`[analytics-retention] dropped ~${dropped} rows in expired partitions`);
  }
}
