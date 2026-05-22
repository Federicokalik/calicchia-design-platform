import { sql } from '../db';
import { logger } from '../lib/logger';

const log = logger.child({ scope: 'quote-expiry' });

/**
 * Mark quotes past their valid_until date as expired
 */
export async function runQuoteExpiry() {
  const result = await sql`
    UPDATE quotes_v2
    SET status = 'expired', updated_at = NOW()
    WHERE status IN ('draft', 'sent', 'viewed')
      AND valid_until < CURRENT_DATE
    RETURNING id, title
  `;

  if (result.length > 0) {
    log.info(`Expired ${result.length} quotes: ${result.map((r) => r.title).join(', ')}`);
  }
}
