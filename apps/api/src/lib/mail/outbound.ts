/**
 * Invio di un'email da una casella collegata (email_accounts): composizione
 * MIME, consegna SMTP e copia nella cartella Inviati via IMAP APPEND.
 *
 * Il messaggio viene composto una sola volta (MailComposer) con Message-ID e
 * data fissati: la stessa struttura, allegati compresi, va al server SMTP e
 * nella copia salvata in Inviati. Differenza unica: la copia mantiene
 * l'intestazione Bcc (come fanno i client di posta), il messaggio consegnato no.
 *
 * Copia in Inviati (email_accounts.sent_copy_mode):
 *  - 'auto' (default): APPEND, salvo i provider che salvano da soli i
 *    messaggi inviati via SMTP (Gmail, Microsoft 365/Outlook), per non
 *    creare duplicati;
 *  - 'append': sempre; 'skip': mai.
 * Prima dell'APPEND si cerca il Message-ID nella cartella: se il provider
 * l'ha già salvato non si duplica. Un errore della copia NON fa fallire
 * l'invio (il messaggio è già partito): viene riportato in `sent_copy`.
 */
import { randomUUID } from 'node:crypto';
import nodemailer from 'nodemailer';
import MailComposer from 'nodemailer/lib/mail-composer';
import type Mail from 'nodemailer/lib/mailer';
import { sql } from '../../db';
import { logger } from '../logger';
import type { EncryptedBlob } from './crypto';
import { decryptSecret } from './crypto';
import { withImap, type ImapCredentials } from './imap-client';
import type { ResolvedAttachment } from './attachments';
import type { MailAddress } from './message-schema';

const log = logger.child({ scope: 'mail-outbound' });

export interface OutboundAccount {
  id: string;
  user_id: string;
  email: string;
  display_name: string | null;
  smtp_host: string;
  smtp_port: number;
  smtp_secure: boolean;
  imap_host: string;
  imap_port: number;
  imap_secure: boolean;
  username: string;
  password_enc: Buffer;
  password_iv: Buffer;
  password_tag: Buffer;
  sent_folder: string | null;
  sent_copy_mode: 'auto' | 'append' | 'skip';
}

/** Casella attiva dell'utente: quella indicata, oppure la prima creata. */
export async function loadOutboundAccount(userId: string | null, accountId?: string | null): Promise<OutboundAccount | null> {
  const byUser = userId ? sql`AND user_id = ${userId}` : sql``;
  const byId = accountId ? sql`AND id = ${accountId}` : sql``;
  const [acc] = await sql<OutboundAccount[]>`
    SELECT id, user_id, email, display_name, smtp_host, smtp_port, smtp_secure,
           imap_host, imap_port, imap_secure, username,
           password_enc, password_iv, password_tag, sent_folder, sent_copy_mode
    FROM email_accounts
    WHERE active = true ${byUser} ${byId}
    ORDER BY created_at ASC
    LIMIT 1
  `;
  return acc ?? null;
}

export interface OutboundMessage {
  to: MailAddress[];
  cc?: MailAddress[];
  bcc?: MailAddress[];
  subject: string;
  text?: string;
  html?: string;
  inReplyTo?: string;
  references?: string[];
  replyTo?: string;
  attachments?: ResolvedAttachment[];
}

export type SentCopyResult =
  | { status: 'saved'; folder: string }
  | { status: 'already_present'; folder: string }
  | { status: 'skipped'; reason: string }
  | { status: 'failed'; error: string; folder?: string };

export interface OutboundResult {
  messageId: string;
  accepted: string[];
  rejected: string[];
  sentCopy: SentCopyResult;
}

/** Errore di consegna SMTP (la route risponde 502 con il motivo del server). */
export class MailDeliveryError extends Error {
  constructor(message: string, readonly responseCode?: number) {
    super(message);
    this.name = 'MailDeliveryError';
  }
}

/** Provider che salvano da soli in Inviati i messaggi inviati via SMTP. */
const SELF_SAVING_SMTP = [/(^|\.)gmail\.com$/i, /(^|\.)googlemail\.com$/i, /(^|\.)office365\.com$/i, /(^|\.)outlook\.com$/i];

const COMMON_SENT_NAMES = ['Sent', 'Sent Items', 'Sent Messages', 'Posta inviata', 'Inviata', 'Inviati', 'INBOX.Sent', 'INBOX.Sent Items'];

function blob(acc: OutboundAccount): EncryptedBlob {
  return { cipher: acc.password_enc, iv: acc.password_iv, tag: acc.password_tag };
}

function fromHeader(acc: OutboundAccount): Mail.Address | string {
  return acc.display_name ? { name: acc.display_name, address: acc.email } : acc.email;
}

function messageIdDomain(email: string): string {
  const domain = email.split('@')[1]?.toLowerCase();
  return domain && /^[a-z0-9.-]+$/.test(domain) ? domain : 'caldes.local';
}

/** Messaggio RFC 5322 completo. `keepBcc` per la copia in Inviati. */
async function compose(options: Mail.Options, keepBcc: boolean): Promise<Buffer> {
  const node = new MailComposer(options).compile();
  (node as unknown as { keepBcc: boolean }).keepBcc = keepBcc;
  return node.build();
}

function shouldAppend(acc: OutboundAccount): { append: true } | { append: false; reason: string } {
  if (acc.sent_copy_mode === 'skip') return { append: false, reason: 'copia disattivata per la casella (sent_copy_mode = skip)' };
  if (acc.sent_copy_mode === 'auto' && SELF_SAVING_SMTP.some((re) => re.test(acc.smtp_host))) {
    return { append: false, reason: `il provider (${acc.smtp_host}) salva da sé i messaggi inviati` };
  }
  return { append: true };
}

async function appendToSent(acc: OutboundAccount, raw: Buffer, messageId: string, date: Date): Promise<SentCopyResult> {
  const creds: ImapCredentials = {
    host: acc.imap_host,
    port: acc.imap_port,
    secure: acc.imap_secure,
    username: acc.username,
    passwordBlob: blob(acc),
  };
  let folder: string | null = acc.sent_folder;
  try {
    const result = await withImap(creds, async (client) => {
      if (!folder) {
        const list = await client.list();
        folder = list.find((b) => b.specialUse === '\\Sent')?.path
          ?? COMMON_SENT_NAMES.map((n) => list.find((b) => b.path === n)?.path).find(Boolean)
          ?? null;
        if (!folder) return { status: 'failed', error: 'cartella Inviati non trovata sulla casella' } as SentCopyResult;
        await sql`UPDATE email_accounts SET sent_folder = ${folder} WHERE id = ${acc.id} AND sent_folder IS NULL`;
      }
      const lock = await client.getMailboxLock(folder);
      try {
        const existing = await client.search({ header: { 'message-id': messageId } }, { uid: true });
        if (Array.isArray(existing) && existing.length) return { status: 'already_present', folder } as SentCopyResult;
        await client.append(folder, raw, ['\\Seen'], date);
        return { status: 'saved', folder } as SentCopyResult;
      } finally {
        lock.release();
      }
    });
    return result;
  } catch (err) {
    log.warn({ err, accountId: acc.id }, 'copia in Inviati non salvata');
    return { status: 'failed', error: (err as Error).message, ...(folder ? { folder } : {}) };
  }
}

/**
 * Invia il messaggio dalla casella e ne salva la copia in Inviati.
 * Lancia MailDeliveryError se il server SMTP rifiuta il messaggio.
 */
export async function sendFromAccount(acc: OutboundAccount, msg: OutboundMessage): Promise<OutboundResult> {
  const messageId = `<${randomUUID()}@${messageIdDomain(acc.email)}>`;
  const date = new Date();
  const options: Mail.Options = {
    from: fromHeader(acc),
    to: msg.to,
    cc: msg.cc?.length ? msg.cc : undefined,
    bcc: msg.bcc?.length ? msg.bcc : undefined,
    subject: msg.subject,
    text: msg.text || undefined,
    html: msg.html || undefined,
    inReplyTo: msg.inReplyTo || undefined,
    references: msg.references?.length ? msg.references : undefined,
    replyTo: msg.replyTo || undefined,
    messageId,
    date,
    // Solo Buffer già validati: niente accesso a file locali o URL da parte di nodemailer.
    disableFileAccess: true,
    disableUrlAccess: true,
    attachments: msg.attachments?.map((a) => ({ filename: a.filename, content: a.content, contentType: a.contentType })),
  };

  const [rawForDelivery, rawForSent] = await Promise.all([compose(options, false), compose(options, true)]);
  const envelopeTo = [...msg.to, ...(msg.cc ?? []), ...(msg.bcc ?? [])].map((a) => a.address);

  const transporter = nodemailer.createTransport({
    host: acc.smtp_host,
    port: acc.smtp_port,
    secure: acc.smtp_secure,
    auth: { user: acc.username, pass: decryptSecret(blob(acc)) },
    disableFileAccess: true,
    disableUrlAccess: true,
  });

  let accepted: string[] = [];
  let rejected: string[] = [];
  try {
    const info = await transporter.sendMail({ envelope: { from: acc.email, to: envelopeTo }, raw: rawForDelivery });
    const asList = (v: unknown) => (Array.isArray(v) ? v.map((x) => (typeof x === 'string' ? x : (x as Mail.Address).address)) : []);
    accepted = asList(info.accepted);
    rejected = asList(info.rejected);
    if (!accepted.length) throw new MailDeliveryError(`nessun destinatario accettato dal server SMTP${info.response ? `: ${info.response}` : ''}`);
  } catch (err) {
    if (err instanceof MailDeliveryError) throw err;
    const e = err as Error & { responseCode?: number; response?: string };
    throw new MailDeliveryError(e.response || e.message, e.responseCode);
  } finally {
    transporter.close();
  }

  const decision = shouldAppend(acc);
  const sentCopy = decision.append
    ? await appendToSent(acc, rawForSent, messageId, date)
    : ({ status: 'skipped', reason: decision.reason } as SentCopyResult);

  return { messageId, accepted, rejected, sentCopy };
}
