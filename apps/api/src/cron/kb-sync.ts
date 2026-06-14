/**
 * Daily KB → S4 backup reconciliation.
 *
 * Only acts when a previous push is owed to S4 (an admin edit that couldn't
 * reach the bucket). In the healthy case there is nothing to do — we don't
 * hammer S4 every day for an already-synced KB. On a persistent failure
 * (e.g. MEGA S4 unpaid) reconcileKbToS4() re-sends the Telegram alert, so the
 * reminder recurs daily until it's fixed.
 */
import { getKbSyncPending, reconcileKbToS4 } from '../lib/agent/kb-sync';

export async function runKbS4Sync(): Promise<void> {
  const pending = await getKbSyncPending();
  if (!pending) return;
  await reconcileKbToS4('cron');
}
