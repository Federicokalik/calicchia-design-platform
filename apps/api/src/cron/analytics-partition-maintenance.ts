/**
 * analytics-partition-maintenance — Pre-creates the next month's partition
 * so we never serve an insert against a missing range.
 */
import { sql } from '../db';
import { logger } from '../lib/logger';

const log = logger.child({ scope: 'analytics-partition' });

export async function runAnalyticsPartitionMaintenance(): Promise<void> {
  const [row] = await sql`SELECT analytics_create_next_partition() AS name` as Array<{ name: string }>;
  if (row?.name && row.name !== 'already_exists') {
    log.info(`created partition ${row.name}`);
  }
}
