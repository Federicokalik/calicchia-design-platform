/**
 * Incremental IMAP sync for a single account.
 *
 * v1 scope:
 *  - Sync only INBOX (and SENT if requested)
 *  - Pull last N messages that we don't have cached
 *  - Handle UIDVALIDITY change by wiping cached rows for that folder
 *  - Skip already-synced messages via UNIQUE(account_id, folder, uid, uidvalidity)
 *  - No IDLE, no push; caller decides when to sync.
 */
import { sql } from '../../db';
import { withImap, detectSentFolder } from './imap-client';
import { parseRawMail } from './mail-parser';
import { autoLinkMessage } from './auto-link';
import { classifyMail } from './classifier';
import { loadUserRules, applyRules } from './rules';
import type { EncryptedBlob } from './crypto';

interface AccountRow {
  id: string;
  user_id: string;
  email: string;
  imap_host: string;
  imap_port: number;
  imap_secure: boolean;
  username: string;
  password_enc: Buffer;
  password_iv: Buffer;
  password_tag: Buffer;
  sent_folder: string | null;
}

function toBlob(row: AccountRow): EncryptedBlob {
  return {
    cipher: row.password_enc,
    iv: row.password_iv,
    tag: row.password_tag,
  };
}

export interface SyncResult {
  folder: string;
  fetched: number;
  skipped: number;
  linksCreated: number;
  serverTotal: number;
  cachedAfter: number;
}

export type SyncMode = 'latest' | 'older' | 'all';

/** Sync one folder (default INBOX) for the given account. Returns stats.
 *
 * Modes:
 * - latest: fetch newest uncached UIDs, capped at maxMessages (routine sync)
 * - older:  fetch UIDs older than the oldest we have cached, up to maxMessages (pagination back in time)
 * - all:    fetch ALL uncached UIDs on server, no cap (initial import)
 */
export async function syncAccountFolder(
  accountId: string,
  folder: string = 'INBOX',
  maxMessages: number = 100,
  mode: SyncMode = 'latest',
): Promise<SyncResult> {
  const [account] = await sql<AccountRow[]>`
    SELECT id, user_id, email, imap_host, imap_port, imap_secure, username, password_enc, password_iv, password_tag, sent_folder
    FROM email_accounts
    WHERE id = ${accountId} AND active = true
    LIMIT 1
  `;
  if (!account) throw new Error(`Account ${accountId} not found or inactive`);

  // Load user rules once per sync batch
  const userRules = await loadUserRules(account.user_id);

  let fetched = 0;
  let skipped = 0;
  let linksCreated = 0;
  let serverTotalCount = 0;

  await withImap(
    {
      host: account.imap_host,
      port: account.imap_port,
      secure: account.imap_secure,
      username: account.username,
      passwordBlob: toBlob(account),
    },
    async (client) => {
      const mailbox = await client.mailboxOpen(folder, { readOnly: true });
      const uidvalidity = Number(mailbox.uidValidity);

      // Check if UIDVALIDITY changed since last sync
      const [known] = await sql<Array<{ uidvalidity: number | null }>>`
        SELECT MAX(uidvalidity)::int AS uidvalidity
        FROM email_messages
        WHERE account_id = ${accountId} AND folder = ${folder}
      `;
      if (known?.uidvalidity && known.uidvalidity !== uidvalidity) {
        // UIDs have been invalidated — wipe local cache for this folder
        await sql`
          DELETE FROM email_messages
          WHERE account_id = ${accountId} AND folder = ${folder}
        `;
      }

      // Find already-cached UIDs
      const cached = await sql<Array<{ uid: number }>>`
        SELECT uid FROM email_messages
        WHERE account_id = ${accountId} AND folder = ${folder} AND uidvalidity = ${uidvalidity}
      `;
      const cachedSet = new Set<number>(cached.map((r) => Number(r.uid)));
      const cachedMin = cached.length > 0 ? Math.min(...cachedSet) : Number.POSITIVE_INFINITY;

      const totalExists = mailbox.exists || 0;
      if (totalExists === 0) return;

      // Get ALL UIDs on the server (cheap — UID-only SEARCH)
      const serverUids = (await client.search({ all: true }, { uid: true })) || [];
      const serverUidNums: number[] = serverUids.map((u) => Number(u));
      serverTotalCount = serverUidNums.length;

      // Determine target UID set based on mode
      let target: number[];
      if (mode === 'all') {
        target = serverUidNums.filter((u) => !cachedSet.has(u));
      } else if (mode === 'older') {
        target = serverUidNums.filter((u) => !cachedSet.has(u) && u < cachedMin);
      } else {
        target = serverUidNums.filter((u) => !cachedSet.has(u));
      }
      // Sort newest first
      target.sort((a, b) => b - a);
      if (mode !== 'all') target = target.slice(0, maxMessages);

      if (target.length === 0) {
        return;
      }

      // Fetch by UID list (comma-separated per imapflow)
      const uidRange = target.join(',');

      for await (const msg of client.fetch(uidRange, {
        uid: true,
        envelope: true,
        source: true,
        flags: true,
      }, { uid: true })) {
        const uid = Number(msg.uid);
        if (cachedSet.has(uid)) {
          skipped++;
          continue;
        }

        const source = msg.source;
        if (!source) continue;

        const parsed = await parseRawMail(source);
        const flags = Array.from(msg.flags ?? []);
        const ruleHit = applyRules(
          {
            fromAddr: parsed.fromAddr,
            subject: parsed.subject,
            listUnsubscribe: parsed.classifierSignals.listUnsubscribe,
          },
          userRules,
        );
        const category =
          ruleHit ??
          classifyMail({
            fromAddr: parsed.fromAddr,
            subject: parsed.subject,
            flags,
            ...parsed.classifierSignals,
          });

        const [inserted] = await sql<Array<{ id: string }>>`
          INSERT INTO email_messages (
            account_id, folder, uid, uidvalidity,
            message_id, thread_id, in_reply_to,
            from_addr, from_name, to_addrs, cc_addrs,
            subject, snippet, body_text, body_html,
            has_attachments, flags, received_at, category
          ) VALUES (
            ${accountId}, ${folder}, ${uid}, ${uidvalidity},
            ${parsed.messageId}, ${parsed.threadId}, ${parsed.inReplyTo},
            ${parsed.fromAddr}, ${parsed.fromName},
            ${JSON.stringify(parsed.toAddrs)}::jsonb,
            ${JSON.stringify(parsed.ccAddrs)}::jsonb,
            ${parsed.subject}, ${parsed.snippet}, ${parsed.text}, ${parsed.html},
            ${parsed.attachments.length > 0}, ${flags},
            ${parsed.receivedAt}, ${category}
          )
          ON CONFLICT (account_id, folder, uid, uidvalidity) DO NOTHING
          RETURNING id
        `;

        if (inserted) {
          // Insert attachment metadata (no blob storage in v1)
          for (const att of parsed.attachments) {
            await sql`
              INSERT INTO email_attachments (message_id, filename, content_type, size_bytes)
              VALUES (${inserted.id}, ${att.filename}, ${att.contentType}, ${att.size})
            `;
          }

          // Auto-link to CRM entities
          linksCreated += await autoLinkMessage(
            inserted.id,
            parsed.fromAddr,
            parsed.toAddrs,
            parsed.ccAddrs,
          );

          fetched++;
        }
      }
    },
  );

  await sql`
    UPDATE email_accounts SET last_sync_at = now(), last_error = NULL
    WHERE id = ${accountId}
  `;

  const [{ count: cachedAfter }] = await sql<Array<{ count: number }>>`
    SELECT COUNT(*)::int AS count FROM email_messages
    WHERE account_id = ${accountId} AND folder = ${folder}
  `;

  return { folder, fetched, skipped, linksCreated, serverTotal: serverTotalCount, cachedAfter };
}

export async function syncAccount(
  accountId: string,
  opts: { mode?: SyncMode; maxMessages?: number; folder?: string; folders?: string[] } = {},
): Promise<SyncResult[]> {
  const { mode = 'latest', maxMessages = 100 } = opts;

  // Determine folders to sync:
  // - if explicit `folders` list → use it
  // - if explicit `folder` → single folder (legacy)
  // - else → INBOX + detected Sent (if any)
  let folders: string[];
  if (opts.folders && opts.folders.length > 0) {
    folders = opts.folders;
  } else if (opts.folder) {
    folders = [opts.folder];
  } else {
    // Load account + auto-detect Sent if missing
    const [acc] = await sql<AccountRow[]>`
      SELECT id, user_id, email, imap_host, imap_port, imap_secure, username,
             password_enc, password_iv, password_tag, sent_folder
      FROM email_accounts WHERE id = ${accountId} LIMIT 1
    `;
    if (!acc) throw new Error(`Account ${accountId} not found`);

    let sentFolder = acc.sent_folder;
    if (!sentFolder) {
      const detected = await detectSentFolder({
        host: acc.imap_host, port: acc.imap_port, secure: acc.imap_secure,
        username: acc.username,
        passwordBlob: { cipher: acc.password_enc, iv: acc.password_iv, tag: acc.password_tag },
      });
      if (detected) {
        await sql`UPDATE email_accounts SET sent_folder = ${detected} WHERE id = ${accountId}`;
        sentFolder = detected;
      }
    }
    folders = ['INBOX'];
    if (sentFolder) folders.push(sentFolder);
  }

  const results: SyncResult[] = [];
  try {
    for (const f of folders) {
      try {
        const r = await syncAccountFolder(accountId, f, maxMessages, mode);
        results.push(r);
      } catch (err) {
        console.error(`[sync] ${accountId} folder=${f}:`, (err as Error).message);
        results.push({
          folder: f, fetched: 0, skipped: 0, linksCreated: 0, serverTotal: 0, cachedAfter: 0,
        });
      }
    }
    return results;
  } catch (err) {
    await sql`
      UPDATE email_accounts SET last_error = ${(err as Error).message.slice(0, 500)}
      WHERE id = ${accountId}
    `;
    throw err;
  }
}
