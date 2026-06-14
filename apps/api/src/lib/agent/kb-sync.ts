/**
 * KB ↔ S4 sync state and reconciliation.
 *
 * The on-disk knowledge base is the source of truth at runtime; S4 is its
 * durable backup so admin edits survive a container restart. When a push to S4
 * fails (MEGA S4 down, credentials/billing lapsed, …) we keep the fresh local
 * files, record a "sync pending" marker, and alert on Telegram. A daily cron
 * ({@link runKbS4Sync}) retries until S4 is reachable again.
 *
 * Two bits of state live in `site_settings` (key/jsonb), outside the validated
 * SETTINGS_KEYS allowlist since they are operational, not user-facing config:
 *   - `kb_s4_sync_pending` → `{ since, reason }` while a push is owed to S4
 *   - `kb_warning_snoozed_until` → `{ until }` to silence the stale banner
 */
import { sql, sqlv } from '../../db';
import { syncKbToS4, type KbSyncResult } from './kb-bootstrap';
import { sendTelegramMessage } from '../telegram';
import { logger } from '../logger';

const log = logger.child({ scope: 'kb-sync' });

const SYNC_PENDING_KEY = 'kb_s4_sync_pending';
const SNOOZE_KEY = 'kb_warning_snoozed_until';

export interface KbSyncPending {
  since: string;
  reason: string;
}

async function readSetting<T>(key: string): Promise<T | null> {
  const [row] = (await sql`
    SELECT value FROM site_settings WHERE key = ${key} LIMIT 1
  `) as Array<{ value: T }>;
  return row?.value ?? null;
}

export function getKbSyncPending(): Promise<KbSyncPending | null> {
  return readSetting<KbSyncPending>(SYNC_PENDING_KEY);
}

async function setKbSyncPending(reason: string): Promise<void> {
  const existing = await getKbSyncPending();
  // Preserve the original `since` so the banner can show how long it's been off.
  const since = existing?.since ?? new Date().toISOString();
  await sql`
    INSERT INTO site_settings (key, value)
    VALUES (${SYNC_PENDING_KEY}, ${sqlv({ since, reason })})
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()
  `;
}

async function clearKbSyncPending(): Promise<void> {
  await sql`DELETE FROM site_settings WHERE key = ${SYNC_PENDING_KEY}`;
}

/** ISO timestamp the stale banner is silenced until, or null if not snoozed / expired. */
export async function getKbSnoozeUntil(): Promise<string | null> {
  const v = await readSetting<{ until: string }>(SNOOZE_KEY);
  if (!v?.until) return null;
  return new Date(v.until).getTime() > Date.now() ? v.until : null;
}

export async function setKbSnooze(until: string): Promise<void> {
  await sql`
    INSERT INTO site_settings (key, value)
    VALUES (${SNOOZE_KEY}, ${sqlv({ until })})
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()
  `;
}

export async function clearKbSnooze(): Promise<void> {
  await sql`DELETE FROM site_settings WHERE key = ${SNOOZE_KEY}`;
}

/**
 * Push the local KB to S4 and track the outcome.
 *
 * Success: clears the pending marker (and pings Telegram if we were recovering
 * from a previous failure). Failure: keeps local files untouched, records the
 * pending marker, and alerts on Telegram — the daily cron will retry.
 *
 * Never throws: a backup hiccup must not break the admin action that triggered it.
 */
export async function reconcileKbToS4(
  trigger: 'admin' | 'cron',
): Promise<KbSyncResult> {
  let res: KbSyncResult;
  try {
    res = await syncKbToS4();
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    log.error({ err: reason, trigger }, 'KB → S4 sync failed; keeping local copy');
    await setKbSyncPending(reason).catch(() => {});
    await sendTelegramMessage(
      '⚠️ <b>Knowledge Base non salvata su S4</b>\n\n' +
        'Le modifiche sono al sicuro in locale, ma il backup su MEGA S4 non è riuscito. ' +
        'Riprovo automaticamente domani.\n\n' +
        '👉 Possibili cause: MEGA S4 offline o abbonamento scaduto/non pagato.\n' +
        `Dettaglio: <code>${escapeHtml(reason)}</code>`,
    ).catch(() => {});
    return { ok: false, skipped: false, pushed: 0, deleted: 0, error: reason };
  }

  if (res.skipped) return res; // S4 not configured — nothing to back up to.

  const wasPending = await getKbSyncPending().catch(() => null);
  await clearKbSyncPending().catch(() => {});
  if (wasPending) {
    await sendTelegramMessage(
      '✅ <b>Knowledge Base di nuovo sincronizzata su S4</b>\n' +
        `Backup allineato (${res.pushed} file su S4).`,
    ).catch(() => {});
  }
  return res;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}
