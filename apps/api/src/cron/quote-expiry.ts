import { sql } from '../db';

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
    console.log(`[Cron] Expired ${result.length} quotes: ${result.map((r) => r.title).join(', ')}`);
  }
}
