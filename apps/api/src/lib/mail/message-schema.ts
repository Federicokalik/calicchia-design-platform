/**
 * Schemi condivisi dei messaggi in uscita (POST /api/mail/send, bozze, tool
 * MCP send_email e draft_email).
 */
import addressparser from 'nodemailer/lib/addressparser';
import { z } from 'zod';
import { attachmentInputSchema } from './attachments';

export interface MailAddress {
  name: string;
  address: string;
}

const EMAIL_RE = /^[^\s@<>(),;:"]+@[^\s@<>(),;:"]+\.[^\s@<>(),;:"]+$/;
export const MAX_RECIPIENTS = 50;

/**
 * Indirizzo in forma stampabile e riparsabile: `Nome <a@b.it>` o `a@b.it`;
 * i nomi con caratteri speciali (virgola, punto e virgola, ...) vanno tra
 * virgolette, altrimenti un elenco unito con ", " si spezzerebbe.
 */
export function formatAddress(a: MailAddress): string {
  if (!a.name) return a.address;
  const name = /[,;<>"@()[\]:\\]/.test(a.name) ? `"${a.name.replace(/(["\\])/g, '\\$1')}"` : a.name;
  return `${name} <${a.address}>`;
}

/**
 * Elenco di destinatari: stringa ("a@b.it, Nome <c@d.it>") o array di
 * stringhe. Il parsing usa l'addressparser di nodemailer, quindi le virgole
 * dentro i nomi tra virgolette non spezzano l'indirizzo. Ogni indirizzo deve
 * essere valido; i duplicati (stesso indirizzo) vengono tolti.
 */
export const addressListSchema = z
  .union([z.string(), z.array(z.string())])
  .transform((value, ctx): MailAddress[] => {
    const parts = Array.isArray(value) ? value : [value];
    const out: MailAddress[] = [];
    const seen = new Set<string>();
    parts.forEach((part, index) => {
      const parsed = addressparser(part, { flatten: true });
      if (!parsed.length && part.trim()) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: Array.isArray(value) ? [index] : [], message: `indirizzo non valido: "${part}"` });
      }
      for (const a of parsed) {
        const address = a.address.trim().toLowerCase();
        if (!EMAIL_RE.test(address)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: Array.isArray(value) ? [index] : [],
            message: `indirizzo email non valido: "${a.address || a.name || part}"`,
          });
          continue;
        }
        if (seen.has(address)) continue;
        seen.add(address);
        out.push({ name: a.name?.trim() ?? '', address });
      }
    });
    if (out.length > MAX_RECIPIENTS) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `al massimo ${MAX_RECIPIENTS} destinatari` });
    }
    return out;
  });

const referencesSchema = z
  .union([z.string(), z.array(z.string())])
  .transform((v) => (Array.isArray(v) ? v : v.split(/\s+/)).map((s) => s.trim()).filter(Boolean));

/** Suggerimenti per i campi sbagliati più frequenti in un messaggio. */
export const MESSAGE_FIELD_HINTS: Readonly<Record<string, string>> = {
  body: 'text (testo semplice) o html',
  message: 'text o html',
  content: 'text o html',
  testo: 'text',
  from: 'account_id (il mittente è la casella)',
  to_addrs: 'to',
  cc_addrs: 'cc',
  bcc_addrs: 'bcc',
  attachment: 'attachments',
  allegati: 'attachments',
  files: 'attachments',
  file: 'attachments',
  inReplyTo: 'in_reply_to',
  replyTo: 'reply_to',
  oggetto: 'subject',
};

/** Body di POST /api/mail/send. Campi sconosciuti → 400. */
export const sendMailSchema = z
  .object({
    account_id: z.string().uuid(),
    to: addressListSchema.refine((l) => l.length > 0, 'almeno un destinatario'),
    cc: addressListSchema.optional(),
    bcc: addressListSchema.optional(),
    subject: z.string().trim().min(1).max(998),
    text: z.string().optional(),
    html: z.string().optional(),
    in_reply_to: z.string().trim().nullable().optional(),
    references: referencesSchema.nullable().optional(),
    reply_to: z.string().trim().toLowerCase().email().optional(),
    attachments: z.array(attachmentInputSchema).optional(),
  })
  .strict()
  .refine((m) => Boolean(m.text?.trim() || m.html?.trim()), { path: ['text'], message: 'serve text o html (non vuoto)' });

export type SendMailBody = z.output<typeof sendMailSchema>;

/** Body di POST /api/mail/drafts. Il testo della bozza è semplice (colonna body). */
export const createDraftSchema = z
  .object({
    account_id: z.string().uuid().optional(),
    to: addressListSchema.optional(),
    cc: addressListSchema.optional(),
    subject: z.string().max(998).optional(),
    text: z.string().optional(),
    reply_to_email_id: z.string().uuid().optional(),
    attachments: z.array(attachmentInputSchema).optional(),
  })
  .strict();

export type CreateDraftBody = z.output<typeof createDraftSchema>;

export const DRAFT_FIELD_HINTS: Readonly<Record<string, string>> = {
  ...MESSAGE_FIELD_HINTS,
  body: 'text',
  html: 'text (le bozze sono in testo semplice)',
};
