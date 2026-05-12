/**
 * Thin wrapper around imapflow. One-shot connection per operation — no long-lived IDLE.
 * Keeps things simple at the cost of a few hundred ms per sync. Optimize later.
 */
import { ImapFlow } from 'imapflow';
import type { EncryptedBlob } from './crypto';
import { decryptSecret } from './crypto';

export interface ImapCredentials {
  host: string;
  port: number;
  secure: boolean;
  username: string;
  passwordBlob: EncryptedBlob;
}

export async function withImap<T>(creds: ImapCredentials, fn: (client: ImapFlow) => Promise<T>): Promise<T> {
  const password = decryptSecret(creds.passwordBlob);
  const client = new ImapFlow({
    host: creds.host,
    port: creds.port,
    secure: creds.secure,
    auth: { user: creds.username, pass: password },
    logger: false,
  });

  await client.connect();
  try {
    return await fn(client);
  } finally {
    try {
      await client.logout();
    } catch {
      // ignore logout errors
    }
  }
}

export async function testImapConnection(creds: ImapCredentials): Promise<{ ok: true; folders: string[] } | { ok: false; error: string }> {
  try {
    const folders = await withImap(creds, async (client) => {
      const list = await client.list();
      return list.map((f) => f.path);
    });
    return { ok: true, folders };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

/** Detect the Sent folder via IMAP SPECIAL-USE, with fallback to common names. */
export async function detectSentFolder(creds: ImapCredentials): Promise<string | null> {
  try {
    return await withImap(creds, async (client) => {
      const list = await client.list();
      // Prefer SPECIAL-USE \Sent flag
      const viaFlag = list.find((b) => (b.specialUse === '\\Sent'));
      if (viaFlag) return viaFlag.path;
      // Fallback to common names (localized + provider-specific)
      const commonNames = [
        'Sent', 'Sent Items', 'Sent Messages',
        'Posta inviata', 'Inviata', 'Inviati',
        'INBOX.Sent', 'INBOX.Sent Items',
      ];
      for (const name of commonNames) {
        const match = list.find((b) => b.path === name);
        if (match) return match.path;
      }
      return null;
    });
  } catch {
    return null;
  }
}
