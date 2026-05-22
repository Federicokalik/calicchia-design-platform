/**
 * data-retention — Daily GDPR / security retention sweep (GDPR-02 / DB-03).
 *
 * Invokes the two Postgres retention functions that, before this job, were
 * defined but never scheduled (migrations 038 and 084):
 *  - run_data_retention(): anonymizes contacts and purges audit_logs,
 *    cookie_consents and analytics past their retention window.
 *  - cleanup_webhook_security_retention(): purges webhook + payment provider
 *    logs older than 30 days.
 *
 * Note: run_data_retention() also calls purge_old_analytics(), which the
 * separate `analytics-retention` job runs too — the second call is a harmless
 * no-op (nothing left to purge).
 */
import { sql } from '../db';
import { logger } from '../lib/logger';

const log = logger.child({ scope: 'data-retention' });

export async function runDataRetention(): Promise<void> {
  const [retention] = (await sql`SELECT run_data_retention() AS result`) as Array<{
    result: Record<string, unknown>;
  }>;
  log.info({ result: retention?.result ?? {} }, 'run_data_retention');

  const [webhook] = (await sql`
    SELECT * FROM cleanup_webhook_security_retention()
  `) as Array<Record<string, number>>;
  log.info(
    { result: webhook ?? {} },
    'cleanup_webhook_security_retention'
  );
}
