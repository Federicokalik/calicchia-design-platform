/**
 * Periodic IMAP sync for all active email accounts.
 * Runs every 5 minutes by default. Each account is synced sequentially
 * to avoid overwhelming the provider or hitting local rate limits.
 *
 * Errors in one account don't block others.
 */
import { sql } from '../db';
import { syncAccount } from '../lib/mail/sync-service';

export async function runMailSync(): Promise<void> {
  if (!process.env.MAIL_ENC_KEY) return; // silently skip if mail not configured

  const accounts = await sql<Array<{ id: string; email: string }>>`
    SELECT id, email
    FROM email_accounts
    WHERE active = true
    ORDER BY last_sync_at ASC NULLS FIRST
  `;

  if (accounts.length === 0) return;

  for (const acc of accounts) {
    try {
      const results = await syncAccount(acc.id);
      const fetched = results.reduce((sum, r) => sum + r.fetched, 0);
      if (fetched > 0) {
        console.log(`[mail-sync] ${acc.email}: ${fetched} new`);
      }
    } catch (err) {
      console.error(`[mail-sync] ${acc.email}: ${(err as Error).message}`);
      // last_error is already stored by syncAccount
    }
  }
}
