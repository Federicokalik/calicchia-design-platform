/**
 * Bozze email (email_drafts) con allegati, condivise fra POST /api/mail/drafts
 * e il tool MCP draft_email.
 *
 * Gli allegati sono uno snapshot: alla creazione i file (inline, da media_id
 * o da URL interno) vengono validati e copiati nello storage privato
 * (PRIVATE_UPLOAD_DIR/mail), così la bozza resta inviabile anche se il media
 * originale viene cancellato. In lettura ogni allegato porta un URL firmato
 * (/api/files/mail/...) che il client admin rimanda a /api/mail/send come
 * riferimento `{ url, filename }`. La cancellazione della bozza rimuove i file.
 */
import { randomUUID } from 'node:crypto';
import { extname } from 'node:path';
import { jsonb, sql } from '../../db';
import { deletePrivateFile, savePrivateFile, signFileUrl } from '../private-files';
import { logger } from '../logger';
import type { ResolvedAttachment } from './attachments';
import { formatAddress, type MailAddress } from './message-schema';

const log = logger.child({ scope: 'mail-drafts' });

export interface StoredDraftAttachment {
  id: string;
  filename: string;
  content_type: string;
  size: number;
  sha256: string;
  /** Nome del file nella categoria privata 'mail'. */
  storage: string;
}

export interface DraftRow {
  id: string;
  account_id: string;
  to_addrs: string[];
  cc_addrs: string[];
  subject: string | null;
  body: string | null;
  in_reply_to_msgid: string | null;
  reply_to_message_id: string | null;
  source: string;
  sent_at: string | null;
  created_at: string;
  attachments: StoredDraftAttachment[] | null;
}

/** Colonne di una bozza (frammento nuovo a ogni query). */
export const draftColumns = () => sql`
  id, account_id, to_addrs, cc_addrs, subject, body,
  in_reply_to_msgid, reply_to_message_id, source, sent_at, created_at, attachments
`;

/** Bozza per le risposte API: allegati con URL firmato, senza il nome interno del file. */
export function presentDraft(row: DraftRow) {
  const { attachments, ...rest } = row;
  return {
    ...rest,
    attachments: (attachments ?? []).map((a) => ({
      id: a.id,
      filename: a.filename,
      content_type: a.content_type,
      size: a.size,
      url: signFileUrl('mail', a.storage),
    })),
  };
}

async function storeAttachments(attachments: ResolvedAttachment[]): Promise<StoredDraftAttachment[]> {
  const stored: StoredDraftAttachment[] = [];
  try {
    for (const a of attachments) {
      const id = randomUUID();
      const storage = `${id}${extname(a.filename).toLowerCase()}`;
      await savePrivateFile('mail', storage, a.content);
      stored.push({ id, filename: a.filename, content_type: a.contentType, size: a.size, sha256: a.sha256, storage });
    }
    return stored;
  } catch (err) {
    await removeStoredFiles(stored);
    throw err;
  }
}

async function removeStoredFiles(attachments: ReadonlyArray<Pick<StoredDraftAttachment, 'storage'>>): Promise<void> {
  for (const a of attachments) {
    try {
      await deletePrivateFile('mail', a.storage);
    } catch (err) {
      log.warn({ err, storage: a.storage }, 'allegato della bozza non rimosso');
    }
  }
}

export interface CreateDraftInput {
  userId: string;
  accountId: string;
  to: MailAddress[];
  cc: MailAddress[];
  subject: string | null;
  body: string | null;
  inReplyToMsgid: string | null;
  replyToMessageId: string | null;
  source: 'manual' | 'ai' | 'reply';
  attachments: ResolvedAttachment[];
}

export async function createDraft(input: CreateDraftInput): Promise<DraftRow> {
  const stored = await storeAttachments(input.attachments);
  try {
    const [row] = await sql<DraftRow[]>`
      INSERT INTO email_drafts (
        user_id, account_id, to_addrs, cc_addrs, subject, body,
        in_reply_to_msgid, reply_to_message_id, source, attachments
      ) VALUES (
        ${input.userId}, ${input.accountId},
        ${jsonb(input.to.map(formatAddress))}::jsonb,
        ${jsonb(input.cc.map(formatAddress))}::jsonb,
        ${input.subject}, ${input.body},
        ${input.inReplyToMsgid}, ${input.replyToMessageId}, ${input.source},
        ${jsonb(stored)}::jsonb
      )
      RETURNING ${draftColumns()}
    `;
    return row;
  } catch (err) {
    await removeStoredFiles(stored);
    throw err;
  }
}

/** Cancella la bozza e i suoi file. Restituisce false se non esiste. */
export async function deleteDraft(userId: string, id: string): Promise<boolean> {
  const [row] = await sql<Array<{ attachments: StoredDraftAttachment[] | null }>>`
    DELETE FROM email_drafts WHERE id = ${id} AND user_id = ${userId} RETURNING attachments
  `;
  if (!row) return false;
  await removeStoredFiles(row.attachments ?? []);
  return true;
}

/** Riferimento al messaggio a cui si risponde (threading), se appartiene all'utente. */
export async function resolveReplyTarget(userId: string, emailId: string | undefined): Promise<{ inReplyToMsgid: string | null; replyToMessageId: string | null }> {
  if (!emailId) return { inReplyToMsgid: null, replyToMessageId: null };
  const [ref] = await sql<Array<{ id: string; message_id: string | null }>>`
    SELECT m.id, m.message_id
    FROM email_messages m
    JOIN email_accounts a ON a.id = m.account_id AND a.user_id = ${userId}
    WHERE m.id = ${emailId}
    LIMIT 1
  `;
  return ref ? { inReplyToMsgid: ref.message_id || null, replyToMessageId: ref.id } : { inReplyToMsgid: null, replyToMessageId: null };
}
